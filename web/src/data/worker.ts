// Decode worker: decodes one row group of one Parquet file per request, and builds the
// derived structures (derive.ts). Results go back as transferable typed arrays.
import type { FileMetaData } from 'hyparquet'
import { decodeRowGroup, isDict, Unsupported, type Column, type NumColumn } from './parquet/decode'
import { readFooter, rowGroupRange } from './parquet/footer'
import { readRange, resetWhole, type TraceFile } from './tracefile'
import { zstdDecoder } from './parquet/zstd'
import { decodeWithHyparquet } from './parquet/fallback'
import { buildDepsByProducer, buildLaneIndex, buildLevels } from './derive'
import { buildOccupancy } from './occupancy'
import { sharedLabels } from './labels'
import { attribute, resetAttribution, taskUsage, type AttributionRequest, type UsageRequest } from './attribution'

export interface DecodeRequest {
  op: 'decode'
  id: number
  file: TraceFile
  name: string
  group: number
  columns: string[] | null
  /** charges only: also build the per-resource index (rows sorted by resource, start) */
  indexResources?: number
  /** charges only: per real resource, the virtual id of its rate class 0 (-1: none); the
   * charges with a class are copied onto their class's virtual resource (views-design 7.2) */
  classBase?: Int32Array
}

export type ComputeRequest =
  | { op: 'levels'; id: number; args: Parameters<typeof buildLevels> }
  | { op: 'laneIndex'; id: number; args: Parameters<typeof buildLaneIndex> }
  | { op: 'depsByProducer'; id: number; args: Parameters<typeof buildDepsByProducer> }
  | { op: 'occupancy'; id: number; args: Parameters<typeof buildOccupancy> }
  | { op: 'attribute'; id: number; req: AttributionRequest }
  | { op: 'taskUsage'; id: number; req: UsageRequest }
  | { op: 'sharedLabels'; id: number; args: Parameters<typeof sharedLabels> }

export interface WorkerReply {
  id: number
  result?: unknown
  ms?: number
  fallback?: boolean
  error?: string
}

const footers = new Map<string, Promise<FileMetaData>>()

function footer(name: string, file: TraceFile): Promise<FileMetaData> {
  let f = footers.get(name)
  if (!f) {
    f = readFooter(file)
    footers.set(name, f)
  }
  return f
}

async function decode(req: DecodeRequest): Promise<{ cols: Record<string, Column>; fallback: boolean }> {
  const [meta, zstd] = await Promise.all([footer(req.name, req.file), zstdDecoder()])
  const [lo, hi] = rowGroupRange(meta, req.group)
  const bytes = await readRange(req.file, lo, hi)
  const columns = req.columns ? new Set(req.columns) : null
  try {
    return { cols: decodeRowGroup(bytes, lo, meta, req.group, columns, zstd), fallback: false }
  } catch (err) {
    if (!(err instanceof Unsupported)) throw err
    console.warn(`r2-vis: ${req.name} row group ${req.group} uses ${err.message}; ` +
      'reading it with the slower general decoder')
    return { cols: await decodeWithHyparquet(req.file, meta, req.group, columns, zstd), fallback: true }
  }
}

/** Every ArrayBuffer under `value` (typed arrays in objects and arrays). */
function buffers(value: unknown, out: ArrayBuffer[] = []): ArrayBuffer[] {
  if (ArrayBuffer.isView(value)) out.push(value.buffer as ArrayBuffer)
  else if (Array.isArray(value)) for (const v of value) buffers(v, out)
  else if (value && typeof value === 'object') for (const v of Object.values(value)) buffers(v, out)
  return out
}

self.onmessage = async (e: MessageEvent<DecodeRequest | ComputeRequest | { op: 'reset' }>) => {
  const req = e.data
  if (req.op === 'reset') {
    footers.clear()
    resetWhole()
    resetAttribution()
    return
  }
  const t0 = performance.now()
  try {
    let result: unknown
    let fallback = false
    if (req.op === 'decode') {
      const d = await decode(req)
      if (req.classBase) d.cols = withClassCharges(d.cols, req.classBase)
      if (req.indexResources) Object.assign(d.cols, indexCharges(d.cols, req.indexResources))
      result = d.cols
      fallback = d.fallback
    } else if (req.op === 'levels') {
      result = buildLevels(...req.args)
    } else if (req.op === 'laneIndex') {
      result = buildLaneIndex(...req.args)
    } else if (req.op === 'occupancy') {
      result = buildOccupancy(...req.args)
    } else if (req.op === 'attribute') {
      result = await attribute(req.req,
        async (name, file, group, columns) => (await decode({ op: 'decode', id: 0, file, name, group, columns })).cols,
        async (name, file, column) => (await footer(name, file)).row_groups.map((rg) => {
          const st = rg.columns.find((c) => c.meta_data?.path_in_schema[0] === column)?.meta_data?.statistics
          const num = (v: unknown) => (typeof v === 'bigint' ? Number(v) : typeof v === 'number' ? v : NaN)
          const lo = num(st?.min_value ?? st?.min)
          const hi = num(st?.max_value ?? st?.max)
          // without statistics: the group may hold any resource
          return [lo === lo ? lo : -Infinity, hi === hi ? hi : Infinity] as [number, number]
        }))
    } else if (req.op === 'sharedLabels') {
      result = sharedLabels(...req.args)
    } else if (req.op === 'taskUsage') {
      result = await taskUsage(req.req,
        async (name, file, group, columns) => (await decode({ op: 'decode', id: 0, file, name, group, columns })).cols)
    } else {
      result = buildDepsByProducer(...req.args)
    }
    const reply: WorkerReply = { id: req.id, result, ms: performance.now() - t0, fallback }
    ;(self as unknown as Worker).postMessage(reply, [...new Set(buffers(result))])
  } catch (err) {
    const reply: WorkerReply = { id: req.id, error: String((err as Error).stack ?? err) }
    ;(self as unknown as Worker).postMessage(reply)
  }
}

/** The charges of a row group with a copy of each charge that has a rate class, on that
 * class's virtual resource (classBase[resource] + class), appended in (resource, start)
 * order after the real rows (virtual ids follow the real ones). */
export function withClassCharges(cols: Record<string, Column>, classBase: Int32Array): Record<string, Column> {
  const cls = cols.class as Int32Array | undefined
  const res = cols.resource as Int32Array
  if (!cls) return cols
  const extra: number[] = []
  for (let i = 0; i < res.length; i++) if (cls[i] >= 0 && res[i] < classBase.length && classBase[res[i]] >= 0) extra.push(i)
  if (!extra.length) return cols
  const start = cols.start as Float64Array
  const virt = (i: number) => classBase[res[i]] + cls[i]
  extra.sort((a, b) => virt(a) - virt(b) || start[a] - start[b])
  const n = res.length
  const out: Record<string, Column> = {}
  for (const [name, col] of Object.entries(cols)) {
    if (isDict(col)) {
      const codes = new Int32Array(n + extra.length)
      codes.set(col.codes)
      extra.forEach((i, k) => { codes[n + k] = col.codes[i] })
      out[name] = { ...col, codes }
      continue
    }
    const num = col as NumColumn
    const Ctor = num.constructor as new (len: number) => NumColumn
    const a = new Ctor(n + extra.length)
    a.set(num)
    extra.forEach((i, k) => { a[n + k] = name === 'resource' ? virt(i) : num[i] })
    out[name] = a
  }
  return out
}

/** Per resource: the rows [__from, __to) of a charges row group and its longest charge. */
function indexCharges(cols: Record<string, Column>, n: number): Record<string, Column> {
  const res = cols.resource as Int32Array
  const start = cols.start as Float64Array
  const end = cols.end as Float64Array
  const from = new Int32Array(n)
  const to = new Int32Array(n)
  const maxSpan = new Float64Array(n)
  for (let i = 0; i < res.length; i++) {
    const r = res[i]
    if (i === 0 || res[i - 1] !== r) from[r] = i
    to[r] = i + 1
    const span = end[i] - start[i]
    if (span > maxSpan[r]) maxSpan[r] = span
  }
  return { __from: from, __to: to, __maxSpan: maxSpan }
}
