// Loading a processed trace into RAM: what trace-format Section 8 reads at open, and the
// structures derived from it in the workers (bin levels, lane index).
import { toRows, type Table } from './columns'
import type { TraceFiles } from './files'
import { fabricGroups } from './fabrics'
import { parseManifest, type Manifest } from './manifest'
import type { WorkerPool } from './pool'
import { TraceReader } from './reader'
import type { BinLevels, LaneIndex } from './derive'

export const DIM_TABLES = ['nodes', 'pes', 'lanes', 'buses', 'attachments', 'links', 'memories',
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
  /** Rate classes (format 1.6, views-design 7.2): each class of a compute resource with
   * per-type rates is a virtual resource appended to dims.resources (class_of: the real
   * resource, rate_class: the class; rate and ceiling: the class's rate), with its own bins
   * and charges. classBase[r]: the virtual id of class 0 of real resource r, else -1;
   * realResources: the number of real resources. */
  classBase: Int32Array
  realResources: number
  load: LoadStats
}

export type Progress = (done: number, total: number) => void

export async function loadTrace(tf: TraceFiles, pool: WorkerPool, progress: Progress): Promise<Trace> {
  const t0 = performance.now()
  const manifestFile = tf.files.get('manifest.json')
  if (!manifestFile) throw new Error('no manifest.json')
  const manifest = parseManifest(await manifestFile.text())
  const reader = new TraceReader(tf.files, pool)
  // A trace before format 1.2 has `bridges` in place of `links` (read as links below).
  const legacy = !reader.has('links') && reader.has('bridges')
  const names = [...DIM_TABLES, ...FACT_TABLES].map((n) => (legacy && n === 'links' ? 'bridges' : n))
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
  if (legacy) byName.links = byName.bridges
  const dims = Object.fromEntries(DIM_TABLES.map((n) => [n, toRows(byName[n])])) as Record<DimName, Row[]>
  if (legacy) bridgesAsLinks(dims)
  const facts = Object.fromEntries(FACT_TABLES.map((n) => [n, byName[n]])) as Record<FactName, Table>
  for (const r of dims.resources) r.capacity = capacityOf(r)
  const realResources = dims.resources.length
  const rateClasses = reader.has('rate_classes') ? toRows(await reader.readColumns('rate_classes', null)) : []
  const classBase = addClassResources(dims, rateClasses)

  const t1 = performance.now()
  const bins = facts.bins.cols
  const tasks = facts.tasks.cols
  const copy = <T extends Int32Array | Float32Array | Float64Array>(a: T) => a.slice() as T
  // The fabric nodes' MAX series are built with the levels (views-design Section 2).
  const fg = fabricGroups(dims)
  const ceiling = Float64Array.from(dims.resources, (r) => (r.ceiling as number | null) ?? NaN)
  const classBins = withClassBins(bins, classBase, dims)
  const binArgs = [classBins.resource, classBins.bin, classBins.amount, dims.resources.length, manifest.bins.count,
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
  // The bins start at the charge extent (format 1.4); the worker builds them from 0.
  levels.origin = manifest.bins.origin ?? 0
  if (levels.fabric) levels.fabric.origin = levels.origin
  const fabricRow = new Map(fg.paths.map((p, g) => [p, g]))
  return { name: tf.name, reader, manifest, dims, facts, levels, lanes, fabricRow, load, classBase, realResources }
}

/** A resource's capacity in slots per core cycle (format 1.6), or its lanes (1.1 to 1.5),
 * or one for a rated resource of a format 1.0 trace; null if unlimited. */
function capacityOf(r: Row): number | null {
  const c = r.capacity ?? r.lanes
  if (c !== undefined && c !== null) return Number(c)
  return r.rate === null || r.rate === undefined ? null : 1
}

/** Appends one virtual resource per rate class (views-design 7.2); returns classBase. */
function addClassResources(dims: Record<DimName, Row[]>, classes: Row[]): Int32Array {
  const base = new Int32Array(dims.resources.length).fill(-1)
  const sorted = [...classes].sort((a, b) => (a.resource as number) - (b.resource as number) || (a.class as number) - (b.class as number))
  for (const c of sorted) {
    const real = dims.resources[c.resource as number]
    if (!real) continue
    const id = dims.resources.length
    if (base[real.id as number] < 0) base[real.id as number] = id
    dims.resources.push({ ...real, id, name: `${String(real.name)}.${String(c.name)}`, rate: c.rate, ceiling: c.rate,
      class_of: real.id, rate_class: c.class, busy_cycles: 0, amount: 0 })
  }
  return base
}

/** The bins with one extra row per row of a rate class, on that class's virtual resource;
 * the virtual resources' amount and busy totals (the rows show only charged classes). */
function withClassBins(bins: Table['cols'], classBase: Int32Array, dims: Record<DimName, Row[]>):
  { resource: Int32Array; bin: Int32Array; amount: Float32Array } {
  const resource = bins.resource as Int32Array
  const bin = bins.bin as Int32Array
  const amount = bins.amount as Float32Array
  const busy = bins.busy as Float32Array | Int32Array
  const cls = bins.class as Int32Array | undefined
  const extra: number[] = []
  if (cls) for (let i = 0; i < resource.length; i++) if (cls[i] >= 0 && classBase[resource[i]] >= 0) extra.push(i)
  const n = resource.length
  const out = { resource: new Int32Array(n + extra.length), bin: new Int32Array(n + extra.length), amount: new Float32Array(n + extra.length) }
  out.resource.set(resource)
  out.bin.set(bin)
  out.amount.set(amount)
  extra.forEach((i, k) => {
    const v = classBase[resource[i]] + (cls as Int32Array)[i]
    out.resource[n + k] = v
    out.bin[n + k] = bin[i]
    out.amount[n + k] = amount[i]
    const row = dims.resources[v]
    row.amount = (row.amount as number) + amount[i]
    row.busy_cycles = (row.busy_cycles as number) + busy[i]
  })
  return out
}

/** A trace before format 1.2: its bridge rows as link rows (trace-format 4.1: from = side a,
 * the child side; to = side b; up = ab), the bridge resources and attachments as those of
 * links. */
function bridgesAsLinks(dims: Record<DimName, Row[]>): void {
  const buses = dims.buses
  dims.links = dims.links.map((b) => {
    const from = b.a_bus as number
    const mem = b.type === 'cache' ? dims.memories.find((m) => m.path === b.path) : undefined
    const ab = b.ab_resource as number | null
    return {
      id: b.id, path: b.path, node: buses[from].node, control: buses[from].control,
      from_bus: from, to_bus: b.b_bus, from_attachment: b.a_attachment, to_attachment: b.b_attachment,
      ab_resource: ab, ba_resource: b.ba_resource, up_dir: b.type === 'cache' ? null : 'ab',
      bw_bytes: ab === null ? null : dims.resources[ab].rate, beat_bytes: null, latency: b.latency,
      cache: mem ? mem.id : null, class: buses[from].class,
    }
  })
  for (const r of dims.resources) {
    if (r.role !== 'bridge') continue
    r.role = 'link'
    r.link = r.bridge
  }
  for (const a of dims.attachments) if (a.component_type === 'bridge') a.component_type = 'link'
}
