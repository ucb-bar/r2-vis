// The source map of a kernel crate (r2-toolchain docs/source-map.md, version 1): its
// programs as item trees, the per-trip values of items inside loops and closures, and the
// links from dependency and wait keys to the invokes whose destination holds them.

/** A per-trip value: a plain value, one list per loop or closure level (null: a trip in
 * which the item did not run), or an affine sequence. */
export type Trips<T> = T | null | Trips<T>[] | Affine
export interface Affine { first: string | number; step: string | number; count: number }

export interface Field {
  expr: string | null
  value: Trips<string>
  addr?: Trips<string>
  self_offset?: Trips<string>
  bytes?: string
  version?: Trips<number>
  /** the destination mask in granules; per trip in a loop */
  mask?: Trips<string>
}

export interface Descriptor {
  dst: Field
  deps: Field[]
  args: Record<string, Field>
}

/** region: a `// region: <text>` … `// endregion` block of the source (summary = text). */
export type ItemKind = 'function' | 'loop' | 'closure' | 'scalar' | 'invoke' | 'wait' | 'region'

export interface Item {
  kind: ItemKind
  file: number
  lines: [number, number]
  summary?: string
  name?: string
  trips?: number
  calls?: number
  children?: Item[]
  pc?: Trips<string>
  op?: string
  pe?: Trips<string>
  descriptor?: Descriptor
  untracked?: boolean
  uncertain?: boolean
  program?: string
  child?: Trips<string>
  /** a spawn: the started program's arguments by field (its #[repr(C)] args struct) */
  child_args?: Record<string, Field>
  /** an invoke or wait: the IMEM offsets of every nu.* instruction that the debug info
   * places at the item (also when the dry run did not reach it); hex strings */
  static_pcs?: string[]
  /** a closure: per call, the line of the statement that made it (null: not known) */
  call_lines?: (number | null)[]
  key?: Field
}

export interface Program {
  program: string
  node: string
  /** sha256: of the IMEM image, lowercase hex (a trace names its images by it) */
  image: { elf: string; entry: string; bytes: number; sha256?: string }
  items: Item[]
  /** the argument values of the dry run come from the first start of this program: the
   * starting program and the pc of its spawn */
  args_from?: { program: string; pc: string }
  notes?: string[]
}

export interface SourceMap {
  format: 'r2-srcmap'
  version: 1
  config: string
  granule?: number
  files: { path: string; text: string }[]
  programs: Program[]
}

/** The name of a source map file without its gzip suffix (NAME.json.gz, format 1.11), so that
 * a map keeps its name in both forms. */
export function mapName(file: string): string {
  return file.slice(file.lastIndexOf('/') + 1).replace(/\.gz$/i, '')
}

/** A source map file: NAME.json, or NAME.json.gz. */
export function isMapFile(file: string): boolean {
  return /\.json(\.gz)?$/i.test(file)
}

/** Reads a source map; only version 1 of the format. */
export function parseSourceMap(text: string, name: string): SourceMap {
  let m: Partial<SourceMap>
  try {
    m = JSON.parse(text) as Partial<SourceMap>
  } catch (err) {
    throw new Error(`${name}: not JSON (${(err as Error).message})`)
  }
  if (m.format !== 'r2-srcmap') throw new Error(`${name}: not a source map (format ${JSON.stringify(m.format)})`)
  if (m.version !== 1) throw new Error(`${name}: source map version ${JSON.stringify(m.version)}; this viewer reads version 1`)
  if (!Array.isArray(m.files) || !Array.isArray(m.programs)) throw new Error(`${name}: source map without files or programs`)
  return m as SourceMap
}

// ---- items ---------------------------------------------------------------------------------

/** An item in the outline: its id (the path of child indices), its parent, its depth and
 * the loop and closure levels that enclose it (outermost first). */
export interface Node {
  id: string
  item: Item
  parent: Node | null
  depth: number
  children: Node[]
  /** the enclosing loops and closures, outermost first */
  levels: Node[]
}

/** The item tree of a program as nodes, with an index by id. */
export function indexProgram(p: Program): { roots: Node[]; byId: Map<string, Node>; all: Node[] } {
  const byId = new Map<string, Node>()
  const all: Node[] = []
  const build = (items: Item[], parent: Node | null, prefix: string, depth: number, levels: Node[]): Node[] =>
    items.map((item, i) => {
      const id = `${prefix}${i}`
      const node: Node = { id, item, parent, depth, children: [], levels }
      byId.set(id, node)
      all.push(node)
      const inner = item.kind === 'loop' || item.kind === 'closure' ? [...levels, node] : levels
      node.children = build(item.children ?? [], node, `${id}.`, depth + 1, inner)
      return node
    })
  const roots = build(p.items, null, '', 0, [])
  return { roots, byId, all }
}

/** The innermost item of a program that holds a line of a file. */
export function innermostAt(all: Node[], file: number, line: number): Node | null {
  let best: Node | null = null
  for (const n of all) {
    const [a, b] = n.item.lines
    if (n.item.file !== file || line < a || line > b) continue
    if (!best || n.depth > best.depth || (n.depth === best.depth && b - a < best.item.lines[1] - best.item.lines[0])) best = n
  }
  return best
}

// ---- per-trip values -------------------------------------------------------------------------

export function isAffine(v: unknown): v is Affine {
  return !!v && typeof v === 'object' && !Array.isArray(v) && 'first' in v && 'step' in v && 'count' in v
}

/** The value is per trip (a list or an affine sequence). */
export function isPerTrip(v: unknown): boolean {
  return Array.isArray(v) || isAffine(v)
}

/** An affine sequence as a list; hex strings stay hex strings. */
export function expandAffine(a: Affine): (string | number)[] {
  const hex = typeof a.first === 'string'
  const first = BigInt(a.first)
  const step = BigInt(a.step)
  return Array.from({ length: a.count }, (_, k) => {
    const v = first + BigInt(k) * step
    return hex ? `0x${v.toString(16)}` : Number(v)
  })
}

/** The trips of a per-trip value: the trip index per level and the value (null: the item
 * did not run in that trip); a plain value is one entry with no index. */
export function tripEntries<T>(v: Trips<T> | undefined): { idx: number[]; value: T | null }[] {
  if (v === undefined) return []
  const out: { idx: number[]; value: T | null }[] = []
  const walk = (x: Trips<T>, idx: number[]) => {
    if (isAffine(x)) {
      expandAffine(x).forEach((e, k) => out.push({ idx: [...idx, k], value: e as T }))
    } else if (Array.isArray(x)) {
      x.forEach((e, k) => walk(e, [...idx, k]))
    } else out.push({ idx, value: x as T | null })
  }
  walk(v, [])
  return out
}

/** The number of trips of a per-trip value (1 for a plain value). */
export function tripCount(v: Trips<unknown> | undefined): number {
  if (isAffine(v)) return v.count
  return Array.isArray(v) ? tripEntries(v).length : 1
}

/** The first value of a per-trip value that is not null. */
export function firstValue<T>(v: Trips<T> | undefined): T | null {
  for (const e of tripEntries(v)) if (e.value !== null) return e.value
  return null
}

/** The value of one trip (by its index per level), or the plain value. */
export function valueAt<T>(v: Trips<T> | undefined, idx: number[]): T | null {
  let x: Trips<T> | undefined = v
  for (const k of idx) {
    if (isAffine(x)) return (expandAffine(x)[k] as T | undefined) ?? null
    if (!Array.isArray(x)) return (x as T | null | undefined) ?? null
    x = x[k]
  }
  return isPerTrip(x) ? firstValue(x as Trips<T>) : (x as T | null | undefined) ?? null
}

/** The calls of a closure as the build saw them: `calls` when written, else the largest
 * per-call list of its items (the level of this closure in their lists). */
export function seenCalls(node: Node): number | null {
  if (node.item.calls !== undefined) return node.item.calls
  return seenTrips(node)
}

/** The trips a level ran, from the per-trip lists of the items inside it. */
export function seenTrips(level: Node): number | null {
  let best: number | null = null
  const visit = (n: Node) => {
    const at = n.levels.indexOf(level)
    if (at >= 0) {
      for (const v of valuesOf(n.item)) {
        for (const e of tripEntries(v)) if (e.idx.length > at) best = Math.max(best ?? 0, e.idx[at] + 1)
      }
    }
    n.children.forEach(visit)
  }
  level.children.forEach(visit)
  return best
}

function valuesOf(item: Item): Trips<unknown>[] {
  const out: Trips<unknown>[] = [item.pc, item.pe, item.child]
  const fields = item.descriptor ? [item.descriptor.dst, ...item.descriptor.deps, ...Object.values(item.descriptor.args)] : []
  if (item.key) fields.push(item.key)
  for (const f of fields) out.push(f.value, f.addr, f.self_offset)
  return out.filter((v) => v !== undefined)
}

// ---- addresses ---------------------------------------------------------------------------------

/** The parts of an address display text: `(gpc0).(sm0).(smem)` (the path and the
 * memory), `0x8000` (the offset) and the rest (` : 0x8000 @v1`); null if not an address. */
export function splitAddress(text: string): { path: string; offset: string; rest: string } | null {
  const m = /^((?:\([^)]*\)\.)*\([^)]*\))\+(\S+)(.*)$/.exec(text)
  return m ? { path: m[1], offset: m[2], rest: m[3] } : null
}

// ---- dependency links --------------------------------------------------------------------------

/** The invoke and trip whose destination holds a key, for each trip of the key. */
export interface DepLink { node: Node; idx: number[] }

interface DstRange {
  node: Node
  idx: number[]
  self: boolean
  base: bigint
  bytes: bigint
  version: number | null
  mask: bigint | null
}

const big = (s: string | null | undefined): bigint | null => {
  if (s === null || s === undefined) return null
  try { return BigInt(s) } catch { return null }
}

/** The destination ranges of a program's invokes, per trip. */
function dstRanges(all: Node[]): DstRange[] {
  const out: DstRange[] = []
  for (const n of all) {
    const d = n.item.descriptor?.dst
    if (n.item.kind !== 'invoke' || !d) continue
    const bytes = big(d.bytes)
    if (bytes === null) continue
    const self = d.addr === null || (d.addr === undefined && d.self_offset !== undefined)
    for (const e of tripEntries(self ? d.self_offset : d.addr)) {
      const base = big(e.value as string | null)
      if (base === null) continue
      const version = valueAt(d.version, e.idx)
      // the mask of this trip (per trip in a loop; absent: the whole range)
      const mask = big(valueAt(d.mask, e.idx))
      out.push({ node: n, idx: e.idx, self, base, bytes, version: version ?? null, mask })
    }
  }
  return out
}

/** Of the ranges that hold a key (an unversioned record reused by every call of a closure
 * holds the keys of all its calls), the producer of the key's trip: in the same closures as
 * the key's item, with as many trip levels, and the same trip; else the last such trip
 * before it; else the first range. */
function closest(hits: DstRange[], from: Node, idx: number[]): DstRange | undefined {
  const closures = (n: Node) => n.levels.filter((l) => l.item.kind === 'closure')
  const mine = closures(from)
  const local = hits.filter((r) => {
    const theirs = closures(r.node)
    return r.idx.length === idx.length && theirs.length === mine.length && theirs.every((c, k) => c === mine[k])
  })
  const at = idx.join(',')
  const exact = local.find((r) => r.idx.join(',') === at)
  if (exact) return exact
  const before = (a: number[], b: number[]) => {
    for (let k = 0; k < Math.min(a.length, b.length); k++) if (a[k] !== b[k]) return a[k] < b[k]
    return a.length <= b.length
  }
  const earlier = local.filter((r) => before(r.idx, idx))
  return earlier[earlier.length - 1] ?? hits[0]
}

/** Links from keys to destinations, built once per program. */
export class DepIndex {
  private readonly ranges: DstRange[]
  private readonly granule: bigint | null

  constructor(all: Node[], granule: number | undefined) {
    this.ranges = dstRanges(all)
    this.granule = granule ? BigInt(granule) : null
  }

  /** Per trip of a key field (a dep or a wait key): the destination that holds it, or
   * null. Global addresses match global ranges, (self) offsets match (self) ranges; the
   * versions must be equal (failing that, a range of unknown version); a masked range
   * holds the granules whose index has no bit outside the mask. With `from` (the key's
   * item), the producer in the same closures and trip (closest). */
  resolve(f: Field, from?: Node): { idx: number[]; link: DepLink | null }[] {
    const self = f.addr === null || (f.addr === undefined && f.self_offset !== undefined)
    return tripEntries(self ? f.self_offset : f.addr).map((e) => {
      const key = big(e.value as string | null)
      if (key === null) return { idx: e.idx, link: null }
      const version = valueAt(f.version, e.idx) ?? null
      const holds = this.ranges.filter((r) => r.self === self && key >= r.base && key < r.base + r.bytes && this.inMask(r, key))
      // The same version; else a range whose version the build cannot know (a range of
      // another node: its owner assigns the version).
      let hits = holds.filter((r) => r.version === version)
      if (!hits.length && version !== null) hits = holds.filter((r) => r.version === null)
      const hit = from ? closest(hits, from, e.idx) : hits[0]
      return { idx: e.idx, link: hit ? { node: hit.node, idx: hit.idx } : null }
    })
  }

  private inMask(r: DstRange, key: bigint): boolean {
    if (r.mask === null) return true
    if (this.granule === null) return false
    const i = (key - r.base) / this.granule
    return (i & ~r.mask) === 0n
  }
}
