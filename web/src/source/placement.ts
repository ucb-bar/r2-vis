// Where a task is in its program's source map: its item and the call statements that led to
// it. Two sources (r2-toolchain docs/source-map.md, version 2; python/r2t/placement.py does
// the same for the converter's check):
// * the call path (trace format 1.12, tasks.call_path): element 0 is a call_pcs entry of a
//   call item of the program function, element 1 one of the helper or closure that it
//   calls, and so on; the pc is then in the static_pcs of an item of the last function. An
//   invoke or wait with call_pcs (a call out of the crate) ends the path. A tail call pushes
//   no frame: the function it jumps to is searched with the caller. A task of the program
//   function whose pc is in a static_pcs_by_call entry is at that call line (an inlined
//   closure copy).
// * the call order, for a trace without call paths: the k-th task of an item in a program
//   start is the item's k-th trip of the dry run when their counts agree, and the trip's
//   closure level is the closure's call (call_lines).
// A task that neither places is at the first item whose pcs hold its pc (pc alone).
import { programIndex, ranTrips, taskPcs, type Node, type Program } from './srcmap'

/** A placed task: its item, the lines of the call statements around it (outermost first),
 * the call items it came through (`via`), and why the call path did not place it ('path': an element names no call of the map;
 * 'pc': no item of the function the path reaches holds the pc; the item then comes from the
 * pc alone). */
export interface Placed {
  node: Node | null
  calls: number[]
  via: Node[]
  miss: 'path' | 'pc' | null
}

interface Scope {
  root: Node
  byPc: Map<number, Node>
  byCallPc: Map<number, Node>
  tails: Node[]
}

const hex = (v: string[] | undefined): number[] => (v ?? []).map(Number).filter(Number.isFinite)

/** Placement by call path in one map program. */
export class ProgramPlacer {
  private readonly helpers = new Map<string, Node>()
  private readonly closures = new Map<string, Node>()
  private readonly scopes = new Map<Node, Scope>()
  private readonly all: Node[]
  private readonly first = new Map<number, Node>()
  private readonly holders = new Map<number, Node[]>()

  constructor(p: Program) {
    const ix = programIndex(p)
    this.all = ix.all
    ix.roots.forEach((r, i) => { if (i > 0 && r.item.kind === 'function') this.helpers.set(r.item.name ?? '', r) })
    for (const n of ix.all) if (n.item.kind === 'closure') this.closures.set(n.item.lines.join(','), n)
    for (const r of [ix.roots[0], ...this.helpers.values(), ...this.closures.values()]) if (r) this.scopes.set(r, this.scope(r))
    for (const n of ix.all) {
      for (const pc of taskPcs(n)) {
        if (!this.first.has(pc)) this.first.set(pc, n)
        const list = this.holders.get(pc)
        if (!list) this.holders.set(pc, [n])
        else if (!list.includes(n)) list.push(n)
      }
    }
  }

  /** Every item whose pcs hold a pc (a version 1 map: items that share pcs share tasks). */
  itemsOfPc(pc: number): readonly Node[] {
    return this.holders.get(pc) ?? []
  }

  /** The items of a function: its subtree (an inlined closure's copies belong to the
   * function around them; an out-of-line closure is also a scope of its own). */
  private scope(root: Node): Scope {
    const s: Scope = { root, byPc: new Map(), byCallPc: new Map(), tails: [] }
    const visit = (n: Node) => {
      for (const pc of taskPcs(n)) if (!s.byPc.has(pc)) s.byPc.set(pc, n)
      const k = n.item.kind
      if (k === 'call' || k === 'invoke' || k === 'wait') for (const pc of hex(n.item.call_pcs)) if (!s.byCallPc.has(pc)) s.byCallPc.set(pc, n)
      if (k === 'call' && n.item.tail) s.tails.push(n)
      n.children.forEach(visit)
    }
    visit(root)
    return s
  }

  /** The helper or closure that a call item calls. */
  callee(call: Node): Node | null {
    const it = call.item
    if (it.function !== undefined) return this.helpers.get(it.function) ?? null
    if (it.closure) return this.closures.get(it.closure.join(',')) ?? null
    return null
  }

  /** The item of a pc alone: the first item (in id order) whose pcs hold it. */
  byPcOnly(pc: number): Node | null {
    return this.first.get(pc) ?? null
  }

  place(path: readonly number[] | null, pc: number): Placed {
    const root = this.all[0] && this.scopes.get(this.all[0])
    const alone = (miss: 'path' | 'pc'): Placed => ({ node: this.byPcOnly(pc), calls: [], via: [], miss })
    if (!root) return alone('path')
    let scope = root
    const calls: number[] = []
    const via: Node[] = []
    for (const e of path ?? []) {
      const call = scope.byCallPc.get(e)
      if (!call) return alone('path')
      calls.push(call.item.lines[0])
      if (call.item.kind === 'invoke' || call.item.kind === 'wait') return { node: call, calls, via, miss: null }
      via.push(call)
      const next = this.callee(call)
      const s = next && this.scopes.get(next)
      if (!s) return alone('path')
      scope = s
    }
    const node = this.inScope(scope, pc, new Set())
    if (!node) return alone('pc')
    if (!path?.length) {
      const line = inlinedCall(node, pc)
      if (line !== null) calls.push(line)
    }
    return { node, calls, via, miss: null }
  }

  /** The item of a pc in a function, or in a function it tail-calls. */
  private inScope(s: Scope, pc: number, seen: Set<Node>): Node | null {
    const hit = s.byPc.get(pc)
    if (hit) return hit
    seen.add(s.root)
    for (const t of s.tails) {
      const next = this.callee(t)
      const ns = next && this.scopes.get(next)
      if (ns && !seen.has(ns.root)) {
        const n = this.inScope(ns, pc, seen)
        if (n) return n
      }
    }
    return null
  }
}

/** The call line of the inlined closure copy that holds a pc, if the item has one. */
export function inlinedCall(n: Node, pc: number): number | null {
  for (const e of n.item.static_pcs_by_call ?? []) if (hex(e.pcs).includes(pc)) return e.line
  return null
}

/** The innermost closure with call_lines around an item, or null. */
export function closureOf(n: Node): Node | null {
  for (let i = n.levels.length - 1; i >= 0; i--) if (n.levels[i].item.kind === 'closure' && n.levels[i].item.call_lines) return n.levels[i]
  return null
}

/** Placement by call order (traces without call paths), with the dry run's trips kept. */
export class CallOrderPlacer {
  private readonly trips = new Map<Node, number[][] | null>()

  /** The call line of each task of one program start (its items in issue order: call time,
   * then gid), for the tasks of items in a closure with call_lines; null where not known.
   * A closure's calls are assigned in a start only when the task counts agree with the dry
   * run for every item of the closure with tasks in the start. */
  callLines(nodes: (Node | null)[]): (number | null)[] {
    const count = new Map<Node, number>()
    for (const n of nodes) if (n) count.set(n, (count.get(n) ?? 0) + 1)
    const runs = new Map<Node, number[][] | null>()
    const broken = new Set<Node>()
    for (const [n, c] of count) {
      if (!this.trips.has(n)) this.trips.set(n, ranTrips(n))
      const r = this.trips.get(n) ?? null
      const ok = r !== null && r.length === c
      runs.set(n, ok ? r : null)
      if (!ok) for (const l of n.levels) if (l.item.kind === 'closure') broken.add(l)
    }
    const seen = new Map<Node, number>()
    return nodes.map((n) => {
      if (!n) return null
      const k = seen.get(n) ?? 0
      seen.set(n, k + 1)
      const closure = closureOf(n)
      const r = runs.get(n)
      if (!closure || !r || broken.has(closure)) return null
      const index = r[k][n.levels.indexOf(closure)]
      return closure.item.call_lines?.[index] ?? null
    })
  }
}
