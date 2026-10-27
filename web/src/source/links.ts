// Links between a trace and its source maps (trace-format 1.9, trace-raw 4.1 and 4.5): a
// program instance of the trace (a programs row) belongs to the source-map program with the
// same name whose image has the same sha256 (no sha256 in the map: the same bytes, an
// unverified link). Its tasks name their item by pc.
import { isDict, type DictColumn } from '../data/columns'
import type { Trace } from '../data/trace'
import { indexProgram, tripEntries, type Node, type Program, type SourceMap } from './srcmap'

/** A source map as loaded (the file name identifies it: a new file of the same name
 * replaces it). `inTrace`: from the open trace's sources/ (format 1.10), replaced when
 * another trace opens. */
export interface LoadedMap { name: string; map: SourceMap; inTrace?: boolean }

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

/** The pcs that a trace's tasks of an item can have: its static_pcs (every instruction the
 * debug info places at it, reached in the dry run or not), else the dry run's pcs. */
export function taskPcs(n: Node): number[] {
  const s = n.item.static_pcs
  return s ? s.map(Number).filter(Number.isFinite) : itemPcs(n)
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
    const ck = `${this.key(mp)}:${n.id}:${k}`
    let hit = this.producerCache.get(ck)
    if (!hit) { hit = this.findProducers(mp, n, k); this.producerCache.set(ck, hit) }
    return hit
  }

  /** Per item (and dependency): its tasks and producers, computed once (a large trace has
   * hundreds of thousands of tasks; a card renders them at each fold). */
  private readonly taskCache = new Map<string, number[]>()
  private readonly producerCache = new Map<string, Producer[]>()

  private findProducers(mp: MapProgram, n: Node, k: number): Producer[] {
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
    const ck = `${this.key(mp)}:${n.id}`
    let hit = this.taskCache.get(ck)
    if (!hit) { hit = this.findTasks(mp, n); this.taskCache.set(ck, hit) }
    return hit
  }

  private findTasks(mp: MapProgram, n: Node): number[] {
    const m = this.byPc.get(this.key(mp))
    if (!m) return []
    // a per-trip pc repeats over the trips of a loop: each pc once
    return [...new Set(taskPcs(n))].flatMap((pc) => m.get(pc) ?? [])
  }

  /** Where a task's pc is in the source: the map program and the item (null if no item has
   * that pc); `missing` names the program when no loaded map matches its instance. */
  locate(task: number): { mp: MapProgram; node: Node | null } | { missing: string } | null {
    const src = taskSource(this.trace, task)
    if (!src) return null
    const inst = this.instance[src.program]
    if (!inst) return { missing: src.name }
    return { mp: inst.mp, node: this.nodeAt(inst.mp, src.pc) }
  }

  /** per map program: pc -> the first item with that pc among its task pcs */
  private readonly pcNodes = new Map<string, Map<number, Node>>()

  private nodeAt(mp: MapProgram, pc: number): Node | null {
    const k = this.key(mp)
    let m = this.pcNodes.get(k)
    if (!m) {
      m = new Map()
      for (const n of programIndex(this.maps[mp.mi].map.programs[mp.pi]).all) {
        for (const p of taskPcs(n)) if (!m.has(p)) m.set(p, n)
      }
      this.pcNodes.set(k, m)
    }
    return m.get(pc) ?? null
  }

  /** The distinct items of tasks (their program instance and pc), in task order; tasks
   * without an item are left out. */
  itemsOf(tasks: readonly number[]): { mp: MapProgram; node: Node }[] {
    const c = this.trace.facts.tasks.cols
    const pc = c.pc as Int32Array | undefined
    const prog = c.program as Int32Array | undefined
    if (!pc || !prog) return []
    const seen = new Set<string>()
    const out: { mp: MapProgram; node: Node }[] = []
    for (const t of tasks) {
      if (pc[t] < 0 || prog[t] < 0) continue
      const inst = this.instance[prog[t]]
      if (!inst) continue
      const key = `${this.key(inst.mp)}:${pc[t]}`
      if (seen.has(key)) continue
      seen.add(key)
      const node = this.nodeAt(inst.mp, pc[t])
      if (node && !out.some((o) => o.node === node)) out.push({ mp: inst.mp, node })
    }
    return out
  }
}

/** The tasks table row of a gid (the table is sorted by gid), or -1. */
export function taskRowOfGid(trace: Trace, gid: number): number {
  const g = trace.facts.tasks.cols.gid as Int32Array
  let lo = 0
  let hi = g.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (g[mid] < gid) lo = mid + 1
    else hi = mid
  }
  return lo < g.length && g[lo] === gid ? lo : -1
}

/** The spawn tasks (task rows) of the program instances of `tasks`, up to the root: an
 * instance's spawn task runs in the spawning program, whose instance has its own spawn. */
export function parentSpawns(trace: Trace, tasks: readonly number[]): number[] {
  const prog = trace.facts.tasks.cols.program as Int32Array | undefined
  const spawn = trace.facts.programs.cols.spawn as Int32Array | Float64Array | undefined
  if (!prog || !spawn) return []
  const instances = new Set<number>()
  for (const t of tasks) if (prog[t] >= 0) instances.add(prog[t])
  const seen = new Set<number>()
  const out: number[] = []
  for (let i of instances) {
    while (i >= 0 && !seen.has(i)) {
      seen.add(i)
      const g = spawn[i]
      if (!(g === g && g >= 0)) break
      const row = taskRowOfGid(trace, g)
      if (row < 0) break
      out.push(row)
      i = prog[row]
    }
  }
  return out
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
