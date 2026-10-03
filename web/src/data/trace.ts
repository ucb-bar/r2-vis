// Loading a processed trace into RAM: what trace-format Section 8 reads at open, and the
// structures derived from it in the workers (bin levels, lane index).
import { toRows, type Table } from './columns'
import type { TraceFiles } from './files'
import { fabricGroups } from './fabrics'
import { parseManifest, type Manifest } from './manifest'
import type { WorkerPool } from './pool'
import { TraceReader } from './reader'
import type { BinLevels, LaneIndex } from './derive'

export const DIM_TABLES = ['nodes', 'pes', 'lanes', 'buses', 'attachments', 'bridges', 'memories',
  'memory_ranges', 'resources', 'opcodes', 'message_kinds', 'dirs', 'dep_states'] as const
export const FACT_TABLES = ['tasks', 'chunks', 'deps', 'programs', 'marks', 'phases', 'bins'] as const

// Columns not read at open (readColumns loads them on demand): the raw label (its fields
// are columns) and the destination range.
const SKIP: Record<string, string[]> = { tasks: ['label', 'dst_base', 'dst_len'] }

export type Row = Record<string, number | string | null>
export type DimName = (typeof DIM_TABLES)[number]
export type FactName = (typeof FACT_TABLES)[number]

export interface TableLoad {
  name: string
  rows: number
  bytes: number
  groups: number
  ms: number
}

export interface LoadStats {
  totalMs: number
  decodeMs: number
  deriveMs: number
  workerMs: number
  workers: number
  fallbackUnits: number
  tables: TableLoad[]
}

export interface Trace {
  name: string
  reader: TraceReader
  manifest: Manifest
  dims: Record<DimName, Row[]>
  facts: Record<FactName, Table>
  levels: BinLevels
  lanes: LaneIndex
  /** fabric node path -> its row in levels.fabric */
  fabricRow: Map<string, number>
  load: LoadStats
}

export type Progress = (done: number, total: number) => void

export async function loadTrace(tf: TraceFiles, pool: WorkerPool, progress: Progress): Promise<Trace> {
  const t0 = performance.now()
  const manifestFile = tf.files.get('manifest.json')
  if (!manifestFile) throw new Error('no manifest.json')
  const manifest = parseManifest(await manifestFile.text())
  const reader = new TraceReader(tf.files, pool)
  const names = [...DIM_TABLES, ...FACT_TABLES]
  const missing = names.filter((n) => !reader.has(n))
  if (missing.length) throw new Error(`missing tables: ${missing.join(', ')}`)

  const groups = await Promise.all(names.map((n) => reader.rowGroups(n)))
  const total = groups.reduce((a, g) => a + g.length, 0) + 2
  let done = 0
  const step = () => progress(++done, total)
  const workerMs0 = pool.stats.workerMs
  const fallback0 = pool.stats.fallbackUnits
  const loads: TableLoad[] = []
  const tables = await Promise.all(names.map(async (name, i) => {
    let columns: string[] | null = null
    if (SKIP[name]) {
      const skip = new Set(SKIP[name])
      columns = (await reader.columnNames(name)).filter((c) => !skip.has(c))
    }
    const table = await reader.readColumns(name, columns, undefined, step)
    loads.push({ name, rows: table.rows, groups: groups[i].length,
      bytes: tf.files.get(`${name}.parquet`)?.size ?? 0, ms: performance.now() - t0 })
    return table
  }))
  const decodeMs = performance.now() - t0
  const byName = Object.fromEntries(names.map((n, i) => [n, tables[i]])) as Record<string, Table>
  const dims = Object.fromEntries(DIM_TABLES.map((n) => [n, toRows(byName[n])])) as Record<DimName, Row[]>
  const facts = Object.fromEntries(FACT_TABLES.map((n) => [n, byName[n]])) as Record<FactName, Table>

  const t1 = performance.now()
  const bins = facts.bins.cols
  const tasks = facts.tasks.cols
  const copy = <T extends Int32Array | Float32Array | Float64Array>(a: T) => a.slice() as T
  // The fabric nodes' MAX series are built with the levels (views-design Section 2).
  const fg = fabricGroups(dims)
  const ceiling = Float64Array.from(dims.resources, (r) => (r.ceiling as number | null) ?? NaN)
  const binArgs = [copy(bins.resource as Int32Array), copy(bins.bin as Int32Array),
    copy(bins.amount as Float32Array), dims.resources.length, manifest.bins.count,
    manifest.bins.width, { start: fg.start, members: fg.members, ceiling }] as const
  const chunks = facts.chunks.cols
  const laneArgs = [copy(tasks.lane as Int32Array), copy(tasks.issue as Float64Array),
    copy(tasks.complete as Float64Array), copy(tasks.gid as Int32Array), copy(tasks.n_chunks as Int32Array),
    copy(chunks.gid as Int32Array), copy(chunks.end as Float64Array), dims.lanes.length,
    manifest.end_time] as const
  const [levels, lanes] = await Promise.all([
    pool.compute<BinLevels>({ op: 'levels', args: [...binArgs] },
      [binArgs[0].buffer, binArgs[1].buffer, binArgs[2].buffer, fg.start.buffer, fg.members.buffer,
        ceiling.buffer]).then((r) => { step(); return r }),
    pool.compute<LaneIndex>({ op: 'laneIndex', args: [...laneArgs] },
      laneArgs.slice(0, 7).map((a) => (a as Int32Array | Float64Array).buffer)).then((r) => { step(); return r }),
  ])
  const load: LoadStats = {
    totalMs: performance.now() - t0, decodeMs, deriveMs: performance.now() - t1,
    workerMs: pool.stats.workerMs - workerMs0, workers: pool.size,
    fallbackUnits: pool.stats.fallbackUnits - fallback0,
    tables: loads.sort((a, b) => names.indexOf(a.name as never) - names.indexOf(b.name as never)),
  }
  const fabricRow = new Map(fg.paths.map((p, g) => [p, g]))
  return { name: tf.name, reader, manifest, dims, facts, levels, lanes, fabricRow, load }
}
