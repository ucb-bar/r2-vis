// Task labels from the label field columns, in the manifest's label format.
import { isDict } from './columns'
import type { WorkerPool } from './pool'
import type { Trace } from './trace'

/** Per trace: the label format without the fields that have one value in every task
 * (views-design 8: `s0` in every name says nothing). The processed data and SQL keep the
 * full label. */
const shortFormats = new WeakMap<Trace, string>()

function displayFormat(trace: Trace): string {
  let f = shortFormats.get(trace)
  if (f !== undefined) return f
  const c = trace.facts.tasks.cols
  const rows = trace.facts.tasks.rows
  const constant = new Set<string>()
  for (const field of trace.manifest.label.fields) {
    const col = c[field.name]
    if (!col || rows === 0) continue
    // One value in every task with a label (NULL: no label, ignored); at least one value.
    const at = (i: number) => (isDict(col) ? col.codes[i] : col[i])
    const isNull = (v: number) => v === -1 || v !== v
    let first: number | null = null
    let same = true
    for (let i = 0; i < rows && same; i++) {
      const v = at(i)
      if (isNull(v)) continue
      if (first === null) first = v
      else same = v === first
    }
    if (same && first !== null) constant.add(field.name)
  }
  // Drop the space-separated parts that hold one constant field and no other field; keep at
  // least one field.
  const parts = trace.manifest.label.format.split(' ')
  const fieldsOf = (p: string) => [...p.matchAll(/\{(\w+)\}/g)].map((m) => m[1])
  const kept = parts.filter((p) => { const fs = fieldsOf(p); return !(fs.length === 1 && constant.has(fs[0])) })
  f = kept.some((p) => fieldsOf(p).length > 0) ? kept.join(' ') : trace.manifest.label.format
  shortFormats.set(trace, f)
  return f
}

/** The task's label as displayed (displayFormat), or null if the dump has no label fields
 * or a field is NULL. */
export function taskLabel(trace: Trace, task: number): string | null {
  const c = trace.facts.tasks.cols
  const fields = trace.manifest.label.fields
  if (fields.length === 0) return null
  let missing = false
  const s = displayFormat(trace).replace(/\{(\w+)\}/g, (_, name: string) => {
    const col = c[name]
    if (!col) { missing = true; return '' }
    if (isDict(col)) {
      const code = col.codes[task]
      if (code < 0) missing = true
      return code < 0 ? '' : col.dict[code]
    }
    const v = col[task]
    if ((col instanceof Int32Array && v === -1) || v !== v) missing = true
    return String(v)
  })
  return missing ? null : s
}

/** Per task: 1 if another task has the same label (sharedLabels, built in a worker at
 * load by indexLabels); until it is ready, no label counts as shared. */
const labelShared_ = new WeakMap<Trace, Uint8Array>()

/** Which tasks share their label with another task, from the label field columns (dict
 * codes or values): a 52-bit hash of the fields, counted. */
export function sharedLabels(fields: (Int32Array | Float64Array)[], rows: number): Uint8Array {
  let h1 = new Int32Array(rows).fill(0x9e3779b9 | 0)
  let h2 = new Int32Array(rows).fill(0x85ebca6b | 0)
  for (const col of fields) {
    const n1 = new Int32Array(rows)
    const n2 = new Int32Array(rows)
    for (let i = 0; i < rows; i++) {
      const x = col[i] | 0
      n1[i] = Math.imul(h1[i] ^ x, 0x01000193)
      n2[i] = Math.imul(h2[i] + x, 0x5bd1e995) ^ (h2[i] >>> 15)
    }
    h1 = n1
    h2 = n2
  }
  const hash = new Float64Array(rows)
  const count = new Map<number, number>()
  for (let i = 0; i < rows; i++) {
    const k = (h1[i] >>> 0) * 2 ** 20 + (h2[i] >>> 12)
    hash[i] = k
    count.set(k, (count.get(k) ?? 0) + 1)
  }
  const out = new Uint8Array(rows)
  for (let i = 0; i < rows; i++) out[i] = (count.get(hash[i]) ?? 0) > 1 ? 1 : 0
  return out
}

/** Starts building the shared-label flags of a trace in a worker (at load). */
export function indexLabels(trace: Trace, pool: WorkerPool): Promise<void> {
  const c = trace.facts.tasks.cols
  const fields = trace.manifest.label.fields.map((f) => c[f.name]).filter((col) => col !== undefined)
    .map((col) => (isDict(col) ? Int32Array.from(col.codes) : Float64Array.from(col as ArrayLike<number>)))
  return pool.compute<Uint8Array>({ op: 'sharedLabels', args: [fields, trace.facts.tasks.rows] })
    .then((flags) => { labelShared_.set(trace, flags) })
}

/** Another task has the same label (false until indexLabels is done). */
export function labelShared(trace: Trace, task: number): boolean {
  return labelShared_.get(trace)?.[task] === 1
}

/** A task's name: its label, with the version appended when another task has the same
 * label (`dma_w s0 l2 u4 #57347 v21`); the opcode name for a task without a label. */
export function taskName(trace: Trace, task: number): string {
  const label = taskLabel(trace, task)
  const c = trace.facts.tasks.cols
  if (label === null) {
    const op = (c.opcode as Int32Array | undefined)?.[task] ?? -1
    return String(trace.dims.opcodes[op]?.name ?? `task ${(c.gid as Int32Array)[task]}`)
  }
  const version = (c.version as Int32Array | undefined)?.[task] ?? -1
  return version >= 0 && labelShared(trace, task) ? `${label} v${version}` : label
}
