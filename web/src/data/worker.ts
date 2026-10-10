// Decode worker: decodes one row group of one Parquet file per request, and builds the
// derived structures (derive.ts). Results go back as transferable typed arrays.
import type { FileMetaData } from 'hyparquet'
import { decodeRowGroup, Unsupported, type Column } from './parquet/decode'
import { readFooter, rowGroupRange } from './parquet/footer'
import { zstdDecoder } from './parquet/zstd'
import { decodeWithHyparquet } from './parquet/fallback'
import { buildDepsByProducer, buildLaneIndex, buildLevels } from './derive'
import { buildOccupancy } from './occupancy'

export interface DecodeRequest {
  op: 'decode'
  id: number
  file: File
  name: string
  group: number
  columns: string[] | null
  /** charges only: also build the per-resource index (rows sorted by resource, start) */
  indexResources?: number
}

export type ComputeRequest =
  | { op: 'levels'; id: number; args: Parameters<typeof buildLevels> }
  | { op: 'laneIndex'; id: number; args: Parameters<typeof buildLaneIndex> }
  | { op: 'depsByProducer'; id: number; args: Parameters<typeof buildDepsByProducer> }
  | { op: 'occupancy'; id: number; args: Parameters<typeof buildOccupancy> }

export interface WorkerReply {
  id: number
  result?: unknown
  ms?: number
  fallback?: boolean
  error?: string
}

const footers = new Map<string, Promise<FileMetaData>>()

function footer(name: string, file: File): Promise<FileMetaData> {
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
  const bytes = await req.file.slice(lo, hi).arrayBuffer()
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
    return
  }
  const t0 = performance.now()
  try {
    let result: unknown
    let fallback = false
    if (req.op === 'decode') {
      const d = await decode(req)
      if (req.indexResources) Object.assign(d.cols, indexCharges(d.cols, req.indexResources))
      result = d.cols
      fallback = d.fallback
    } else if (req.op === 'levels') {
      result = buildLevels(...req.args)
    } else if (req.op === 'laneIndex') {
      result = buildLaneIndex(...req.args)
    } else if (req.op === 'occupancy') {
      result = buildOccupancy(...req.args)
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
