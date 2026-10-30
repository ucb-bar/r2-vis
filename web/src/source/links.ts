// Links between a trace and its source maps (trace-format 1.9, trace-raw 4.1 and 4.5): a
// program instance of the trace (a programs row) belongs to the source-map program with the
// same name whose image has the same sha256 (no sha256 in the map: the same bytes, an
// unverified link). Its tasks are placed at their items by pc and call path, or by call
// order (placement.ts).
import { isDict, type DictColumn } from '../data/columns'
import type { Trace } from '../data/trace'
import { CallOrderPlacer, closureOf, ProgramPlacer } from './placement'
import { itemPcs, programIndex, taskPcs, type Node, type SourceMap } from './srcmap'

export { itemPcs, programIndex, taskPcs }

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


/** Where a task is: its map program, its item, and the lines of the call statements that
 * led to it, outermost first (empty for a task of the program function itself). */
export interface TaskPlace { mp: MapProgram; node: Node | null; calls: readonly number[]; via: readonly Node[] }

/** Tasks of an item grouped by where they came from: a call line (or chain of them), or the
 * statement that spawned their program start; `label` is the region around that line. */
export interface TaskGroup { key: string; lines: readonly number[]; label: string | null; tasks: number[] }

/** A producer of a dependency: where it is in the source and its tasks. */
export interface Producer {
  mp: MapProgram | null
  node: Node | null
  program: string
  pc: number | null
  tasks: number[]
}



export class SourceLink {
  private readonly trace: Trace
  private readonly maps: LoadedMap[]
  /** per program instance (programs row): the map program, and whether sha256 checked it */
  private readonly instance: ({ mp: MapProgram; verified: boolean } | null)[]
  private readonly status = new Map<string, MapStatus>()
  /** per task row: its place (null: no loaded map holds its program), built on first use */
  private places: (TaskPlace | null)[] | null = null
  /** per item: its task rows, in row order; per call item: the task rows that came through it */
  private readonly byNode = new Map<Node, number[]>()
  private readonly byCall = new Map<Node, number[]>()
  private readonly placers = new Map<string, ProgramPlacer>()
  /** per program instance: the lines of the statement that spawned it (null: none known) */
  private readonly startLines = new Map<number, { mp: MapProgram; lines: readonly number[] } | null>()

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
  }

  /** The places of all tasks: by call path and pc (one placement per distinct program,
   * path and pc); in a trace without call paths, the tasks of closures by call order. */
  private place(): (TaskPlace | null)[] {
    if (this.places) return this.places
    const c = this.trace.facts.tasks.cols
    const pc = c.pc as Int32Array | undefined
    const prog = c.program as Int32Array | undefined
    const path = c.call_path as Int32Array | undefined
    const rows = this.trace.facts.tasks.rows
    const out: (TaskPlace | null)[] = new Array(rows).fill(null)
    this.places = out
    if (!pc || !prog) return out
    const placers = this.placers
    const memo = new Map<string, TaskPlace>()

    const paths = this.trace.callPaths
    for (let t = 0; t < rows; t++) {
      if (pc[t] < 0 || prog[t] < 0) continue
      const inst = this.instance[prog[t]]
      if (!inst) continue
      const k = this.key(inst.mp)
      const cp = path ? path[t] : -1
      const mk = `${k}|${cp}|${pc[t]}`
      let place = memo.get(mk)
      if (!place) {
        let placer = placers.get(k)
        if (!placer) { placer = new ProgramPlacer(this.maps[inst.mp.mi].map.programs[inst.mp.pi]); placers.set(k, placer) }
        const got = placer.place(cp >= 0 ? paths[cp] ?? null : null, pc[t])
        place = { mp: inst.mp, node: got.node, calls: got.calls, via: got.via }
        memo.set(mk, place)
      }
      out[t] = place
    }
    if (!paths.length) this.placeByCallOrder(out)
    const add = (n: Node, t: number) => {
      const list = this.byNode.get(n)
      if (list) list.push(t)
      else this.byNode.set(n, [t])
    }
    // a version 1 map has no calls: an item's tasks are those of its pcs, shared with the
    // other items of the same pcs (as before version 2)
    for (let t = 0; t < rows; t++) {
      const p = out[t]
      if (!p?.node) continue
      for (const v of p.via) {
        const list = this.byCall.get(v)
        if (list) list.push(t)
        else this.byCall.set(v, [t])
      }
      if (this.maps[p.mp.mi].map.version === 1) {
        for (const m of placers.get(this.key(p.mp))?.itemsOfPc(pc[t]) ?? [p.node]) add(m, t)
      } else add(p.node, t)
    }
    return out
  }

  /** A trace without call paths: the tasks of items in closures with call_lines get their
   * call line from the call order of their program start (issue order: call, then gid). */
  private placeByCallOrder(out: (TaskPlace | null)[]): void {
    const prog = this.trace.facts.tasks.cols.program as Int32Array
    const call = this.trace.facts.tasks.cols.call as Float64Array
    const starts = new Map<number, number[]>()
    for (let t = 0; t < out.length; t++) {
      const n = out[t]?.node
      if (!n || !closureOf(n)) continue
      const list = starts.get(prog[t])
      if (list) list.push(t)
      else starts.set(prog[t], [t])
    }
    if (!starts.size) return
    // all tasks of those starts take part in the count of each item
    const all = new Map<number, number[]>()
    for (let t = 0; t < out.length; t++) if (starts.has(prog[t]) && out[t]?.node) (all.get(prog[t]) ?? all.set(prog[t], []).get(prog[t]) as number[]).push(t)
    const placer = new CallOrderPlacer()
    for (const rows of all.values()) {
      rows.sort((a, b) => call[a] - call[b] || a - b)
      const lines = placer.callLines(rows.map((t) => out[t]?.node ?? null))
      rows.forEach((t, i) => {
        const line = lines[i]
        const p = out[t]
        if (line !== null && p) out[t] = { ...p, calls: [line] }
      })
    }
  }

  private key(mp: MapProgram): string {
    return `${mp.mi}:${mp.pi}`
  }

  /** The map program of a program instance (programs row); null if no loaded map holds it. */
  instanceOf(program: number): MapProgram | null {
    return this.instance[program]?.mp ?? null
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

  /** The task rows placed at an item (in row order). */
  tasksOf(_mp: MapProgram, n: Node): number[] {
    this.place()
    return this.byNode.get(n) ?? []
  }

  /** The task rows of an item by the call statements that led to them (key: the call
   * lines, outermost first, joined by '/'; '' for the item's own function), in order of
   * the first task. */
  tasksByCall(mp: MapProgram, n: Node): Map<string, number[]> {
    const places = this.place()
    const out = new Map<string, number[]>()
    for (const t of this.tasksOf(mp, n)) {
      const k = places[t]?.calls.join('/') ?? ''
      const list = out.get(k)
      if (list) list.push(t)
      else out.set(k, [t])
    }
    return out
  }

  /** Where a task is in the source: the map program and the item (null if no item holds
   * it) with its call lines; `missing` names the program when no loaded map matches its
   * instance. */
  locate(task: number): (TaskPlace & { mp: MapProgram }) | { missing: string } | null {
    const src = taskSource(this.trace, task)
    if (!src) return null
    const inst = this.instance[src.program]
    if (!inst) return { missing: src.name }
    return this.place()[task] ?? { mp: inst.mp, node: null, calls: [], via: [] }
  }

  /** The task rows that came through a call item (a call of a helper or closure). */
  tasksViaCall(call: Node): number[] {
    this.place()
    return this.byCall.get(call) ?? []
  }

  /** The helper or out-of-line closure that a call item of a map program calls. */
  callee(mp: MapProgram, call: Node): Node | null {
    this.place()
    let placer = this.placers.get(this.key(mp))
    if (!placer) { placer = new ProgramPlacer(this.maps[mp.mi].map.programs[mp.pi]); this.placers.set(this.key(mp), placer) }
    return placer.callee(call)
  }

  /** The summary of the innermost region around a line of a map program (its first file),
   * or null. */
  regionAt(mp: MapProgram, line: number): string | null {
    const ix = programIndex(this.maps[mp.mi].map.programs[mp.pi])
    const file = ix.roots[0]?.item.file
    let best: Node | null = null
    for (const n of ix.all) {
      const [a, b] = n.item.lines
      if (n.item.kind !== 'region' || !n.item.summary || n.item.file !== file || line < a || line > b) continue
      if (!best || n.depth > best.depth) best = n
    }
    return best?.item.summary ?? null
  }

  private readonly callGroups = new Map<Node, TaskGroup[]>()
  private readonly startGroups = new Map<Node, TaskGroup[]>()

  /** An item's tasks grouped by the call lines that led to them, and by the statement that
   * spawned their program start (each empty when the tasks form one group); kept per item. */
  groupsOf(mp: MapProgram, n: Node): { byCall: TaskGroup[]; byStart: TaskGroup[] } {
    let byCall = this.callGroups.get(n)
    if (!byCall) { byCall = this.groupsByCall(mp, n); this.callGroups.set(n, byCall) }
    let byStart = this.startGroups.get(n)
    if (!byStart) { byStart = this.groupsByStart(this.tasksOf(mp, n)); this.startGroups.set(n, byStart) }
    return { byCall, byStart }
  }

  /** An item's tasks grouped by the call lines that led to them (empty: one group or none). */
  private groupsByCall(mp: MapProgram, n: Node): TaskGroup[] {
    const groups = [...this.tasksByCall(mp, n)].map(([key, tasks]) => {
      const lines = key ? key.split('/').map(Number) : []
      return { key, lines, label: lines.length ? this.regionAt(mp, lines[0]) : null, tasks }
    })
    return groups.length > 1 ? groups.sort((x, y) => (x.lines[0] ?? 0) - (y.lines[0] ?? 0)) : []
  }

  /** The lines of the statement that spawned a program start: its spawn task's call lines,
   * else its spawn item's line; null when not known. */
  startLine(program: number): { mp: MapProgram; lines: readonly number[] } | null {
    if (this.startLines.has(program)) return this.startLines.get(program) ?? null
    const p = this.spawnPlace(program)
    const got = p ? { mp: p.mp, lines: p.calls.length ? p.calls : p.node ? [p.node.item.lines[0]] : [] } : null
    const known = got && got.lines.length ? got : null
    this.startLines.set(program, known)
    return known
  }

  /** Tasks grouped by the statement that spawned their program start (option 3:
   * the six calls of a child program); empty when they all come from one statement. */
  private groupsByStart(tasks: readonly number[]): TaskGroup[] {
    const prog = this.trace.facts.tasks.cols.program as Int32Array | undefined
    if (!prog) return []
    const out = new Map<string, TaskGroup>()
    for (const t of tasks) {
      const s = prog[t] >= 0 ? this.startLine(prog[t]) : null
      const key = s ? s.lines.join('/') : ''
      let g = out.get(key)
      if (!g) {
        g = { key, lines: s?.lines ?? [], label: s ? this.regionAt(s.mp, s.lines[0]) : null, tasks: [] }
        out.set(key, g)
      }
      g.tasks.push(t)
    }
    return out.size > 1 ? [...out.values()].sort((x, y) => (x.lines[0] ?? Infinity) - (y.lines[0] ?? Infinity)) : []
  }

  /** Where the start of a program instance (a programs row) was made: the place of its
   * spawn task in the parent program; null for the root or when no map holds the parent. */
  spawnPlace(program: number): TaskPlace | null {
    const spawn = this.trace.facts.programs.cols.spawn as Int32Array | Float64Array | undefined
    const g = spawn ? spawn[program] : NaN
    if (!(g === g && g >= 0)) return null
    const row = taskRowOfGid(this.trace, g)
    return row < 0 ? null : this.place()[row]
  }

  /** The distinct items of tasks (their program instance and pc), in task order; tasks
   * without an item are left out. */
  itemsOf(tasks: readonly number[]): { mp: MapProgram; node: Node }[] {
    const places = this.place()
    const seen = new Set<Node>()
    const out: { mp: MapProgram; node: Node }[] = []
    for (const t of tasks) {
      const p = places[t]
      if (!p?.node || seen.has(p.node)) continue
      seen.add(p.node)
      out.push({ mp: p.mp, node: p.node })
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

const links = new WeakMap<Trace, WeakMap<LoadedMap[], SourceLink>>()

/** The link of a trace and a list of loaded maps, one per list (views that ask with an
 * older list, as the focus queries do for a moment at load, do not replace the link of the
 * current list). */
export function linkFor(trace: Trace, maps: LoadedMap[]): SourceLink {
  let byMaps = links.get(trace)
  if (!byMaps) { byMaps = new WeakMap(); links.set(trace, byMaps) }
  let link = byMaps.get(maps)
  if (!link) { link = new SourceLink(trace, maps); byMaps.set(maps, link) }
  return link
}
