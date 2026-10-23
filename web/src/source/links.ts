// Links between a trace and its source maps (trace-format 1.9, trace-raw 4.1 and 4.5): a
// program instance of the trace (a programs row) belongs to the source-map program with the
// same name whose image has the same sha256 (no sha256 in the map: the same bytes, an
// unverified link). Its tasks name their item by pc.
import { isDict, type DictColumn } from '../data/columns'
import type { Trace } from '../data/trace'
import { indexProgram, tripEntries, type Node, type Program, type SourceMap } from './srcmap'

/** A source map as loaded (the file name identifies it: a new file of the same name
 * replaces it). */
export interface LoadedMap { name: string; map: SourceMap }

/** A program of a loaded map: map index and program index. */
export interface MapProgram { mi: number; pi: number }

/** How a map program relates to the open trace: its image ran (sha256 equal), ran with
 * the same bytes (the map has no sha256), or a program of that name ran another image. */
export type MapStatus = 'match' | 'unverified' | 'stale'

/** The program and pc of a task, or null for a task of a program that is not an RV image
 * (or a trace before format 1.9). */
export function taskSource(trace: Trace, task: number): { program: number; name: string; pc: number } | null {
  const c = trace.facts.tasks.cols
  const pc = c.pc as Int32Array | undefined
  const prog = c.program as Int32Array | undefined
  if (!pc || !prog || pc[task] < 0 || prog[task] < 0) return null
  return { program: prog[task], name: programName(trace, prog[task]), pc: pc[task] }
}

function programName(trace: Trace, row: number): string {
  const col = trace.facts.programs.cols.name
  if (col && isDict(col)) return (col as DictColumn).dict[(col as DictColumn).codes[row]] ?? ''
  return ''
}

/** The pcs of an item (a plain value or per trip), as numbers. */
export function itemPcs(n: Node): number[] {
  const out: number[] = []
  for (const e of tripEntries<string>(n.item.pc)) {
    const v = e.value === null ? NaN : Number(e.value)
    if (Number.isFinite(v)) out.push(v)
  }
  return out
}

/** A producer of a dependency: where it is in the source and its tasks. */
export interface Producer {
  mp: MapProgram | null
  node: Node | null
  program: string
  pc: number | null
  tasks: number[]
}

const indexes = new WeakMap<Program, ReturnType<typeof indexProgram>>()

/** The item tree of a program, built once per program. */
export function programIndex(p: Program): ReturnType<typeof indexProgram> {
  let ix = indexes.get(p)
  if (!ix) { ix = indexProgram(p); indexes.set(p, ix) }
  return ix
}

export class SourceLink {
  private readonly trace: Trace
  private readonly maps: LoadedMap[]
  /** per program instance (programs row): the map program, and whether sha256 checked it */
  private readonly instance: ({ mp: MapProgram; verified: boolean } | null)[]
  private readonly status = new Map<string, MapStatus>()
  /** per map program: (pc -> task rows) of its instances */
  private readonly byPc = new Map<string, Map<number, number[]>>()

  constructor(trace: Trace, maps: LoadedMap[]) {
    this.trace = trace
    this.maps = maps
    const progs = trace.facts.programs
    const image = progs.cols.image as Int32Array | undefined
    const images = trace.images
    this.instance = Array.from({ length: progs.rows }, (_, r) => {
      const img = image && image[r] >= 0 ? images[image[r]] : undefined
      if (!img) return null
      const name = programName(trace, r)
      for (const [mi, m] of maps.entries()) {
        for (const [pi, p] of m.map.programs.entries()) {
          if (p.program !== name) continue
          const key = `${mi}:${pi}`
          const sha = p.image.sha256
          const hit = sha ? sha.toLowerCase() === String(img.sha256).toLowerCase() : p.image.bytes === img.bytes
          if (hit) {
            const st: MapStatus = sha ? 'match' : 'unverified'
            this.status.set(key, st)
            return { mp: { mi, pi }, verified: !!sha }
          }
          if (!this.status.has(key)) this.status.set(key, 'stale')
        }
      }
      return null
    })
    // A map program that matched one instance is not stale for another (a renamed copy).
    for (const inst of this.instance) if (inst) this.status.set(this.key(inst.mp), inst.verified ? 'match' : 'unverified')
    const c = trace.facts.tasks.cols
    const pc = c.pc as Int32Array | undefined
    const prog = c.program as Int32Array | undefined
    if (!pc || !prog) return
    for (let t = 0; t < pc.length; t++) {
      if (pc[t] < 0 || prog[t] < 0) continue
      const inst = this.instance[prog[t]]
      if (!inst) continue
      const k = this.key(inst.mp)
      let m = this.byPc.get(k)
      if (!m) { m = new Map(); this.byPc.set(k, m) }
      const list = m.get(pc[t])
      if (list) list.push(t)
      else m.set(pc[t], [t])
    }
  }

  private key(mp: MapProgram): string {
    return `${mp.mi}:${mp.pi}`
  }

  /** The status of a map program for this trace; null if no program of its name ran an image. */
  statusOf(mp: MapProgram): MapStatus | null {
    return this.status.get(this.key(mp)) ?? null
  }

  /** per task row: its dependency rows (built when first asked for) */
  private depsByConsumer: Map<number, number[]> | null = null
  private rowOfGid: Map<number, number> | null = null

  /** The producers of dependency `k` of an invoke, from the trace's deps table: the
   * distinct (program, pc) of the producing tasks, each with its map program and item (null
   * if no loaded map holds it) and the producing task rows. */
  producersOf(mp: MapProgram, n: Node, k: number): Producer[] {
    const d = this.trace.facts.deps.cols
    const consumer = d.consumer as Int32Array
    const idx = d.idx as Int32Array | Int8Array | undefined
    const producer = d.producer as Int32Array
    const gid = this.trace.facts.tasks.cols.gid as Int32Array
    if (!this.depsByConsumer) {
      this.rowOfGid = new Map(Array.from(gid, (g, row) => [g, row]))
      this.depsByConsumer = new Map()
      for (let r = 0; r < consumer.length; r++) {
        const row = this.rowOfGid.get(consumer[r])
        if (row === undefined) continue
        const list = this.depsByConsumer.get(row)
        if (list) list.push(r)
        else this.depsByConsumer.set(row, [r])
      }
    }
    const out = new Map<string, Producer>()
    for (const t of this.tasksOf(mp, n)) {
      for (const r of this.depsByConsumer.get(t) ?? []) {
        if ((idx ? idx[r] : 0) !== k || producer[r] < 0) continue
        const p = this.rowOfGid?.get(producer[r])
        if (p === undefined) continue
        const src = taskSource(this.trace, p)
        const at = this.locate(p)
        const key = at && 'mp' in at ? `${at.mp.mi}:${at.mp.pi}:${at.node?.id ?? ''}` : `${src?.name}:${src?.pc}`
        let e = out.get(key)
        if (!e) {
          e = { mp: at && 'mp' in at ? at.mp : null, node: at && 'mp' in at ? at.node : null,
            program: src?.name ?? '', pc: src?.pc ?? null, tasks: [] }
          out.set(key, e)
        }
        if (!e.tasks.includes(p)) e.tasks.push(p)
      }
    }
    return [...out.values()]
  }

  /** The task rows of a map program's instances whose pc is one of an item's pcs. */
  tasksOf(mp: MapProgram, n: Node): number[] {
    const m = this.byPc.get(this.key(mp))
    if (!m) return []
    return itemPcs(n).flatMap((pc) => m.get(pc) ?? [])
  }

  /** Where a task's pc is in the source: the map program and the item (null if no item has
   * that pc); `missing` names the program when no loaded map matches its instance. */
  locate(task: number): { mp: MapProgram; node: Node | null } | { missing: string } | null {
    const src = taskSource(this.trace, task)
    if (!src) return null
    const inst = this.instance[src.program]
    if (!inst) return { missing: src.name }
    const program = this.maps[inst.mp.mi].map.programs[inst.mp.pi]
    const node = programIndex(program).all.find((n) => itemPcs(n).includes(src.pc)) ?? null
    return { mp: inst.mp, node }
  }
}

const links = new WeakMap<Trace, { maps: LoadedMap[]; link: SourceLink }>()

/** The link of a trace and a list of loaded maps (built again when the list changes). */
export function linkFor(trace: Trace, maps: LoadedMap[]): SourceLink {
  const cached = links.get(trace)
  if (cached && cached.maps === maps) return cached.link
  const link = new SourceLink(trace, maps)
  links.set(trace, { maps, link })
  return link
}
