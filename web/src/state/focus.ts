// The focus (S10): the one selection that all views share. It has four parts: tasks (task
// rows), time (an instant or a range), resources (resource ids) and source items. A gesture
// sets some parts (fixed) and clears the others; one pass then derives the cleared parts
// along the edges below. A part is written at most once per pass and never when it is
// fixed, so a derived part feeds only the parts not yet set (no back edge). Time and
// resources come only from gestures.
//
//   1. items -> tasks: the tasks at the items' pcs in all instances of their programs,
//      with the spawn tasks of those instances up to the root
//   2. tasks -> items: the items of the tasks' (program, pc)
//   3. resources + time -> tasks: the occupants of the resources at the instant or over
//      the range (in the attribution scope)
//
// This module has no runtime imports: the queries come from the caller (state/
// focusqueries.ts in the app, plain functions in a test).

export type FocusTime = { t: number } | { a: number; b: number }

/** A source item: the loaded map's name, the program and the item id. */
export interface FocusItem { map: string; program: string; id: string }

export type PartName = 'tasks' | 'time' | 'resources' | 'items'

export const PART_NAMES: readonly PartName[] = ['items', 'tasks', 'time', 'resources']

export interface Parts {
  tasks: readonly number[] | null
  time: FocusTime | null
  resources: readonly number[] | null
  items: readonly FocusItem[] | null
}

export interface Focus extends Parts {
  /** the parts the gesture set */
  fixed: ReadonlySet<PartName>
  /** the derived parts still being computed */
  pending: ReadonlySet<PartName>
}

export const EMPTY_FOCUS: Focus = { tasks: null, time: null, resources: null, items: null, fixed: new Set(), pending: new Set() }

/** The queries behind the edges. Each may return a promise (worker queries). */
export interface FocusQueries {
  tasksOfItems(items: readonly FocusItem[]): number[] | Promise<number[]>
  itemsOf(tasks: readonly number[]): FocusItem[] | Promise<FocusItem[]>
  occupants(resources: readonly number[], time: FocusTime): number[] | Promise<number[]>
}

interface Edge {
  to: PartName
  from: PartName[]
  run: (p: Parts, q: FocusQueries) => unknown
}

/** The edges in the order they are tried: tasks come from items before resources + time. */
const EDGES: Edge[] = [
  { to: 'tasks', from: ['items'], run: (p, q) => q.tasksOfItems(p.items ?? []) },
  { to: 'items', from: ['tasks'], run: (p, q) => q.itemsOf(p.tasks ?? []) },
  { to: 'tasks', from: ['resources', 'time'], run: (p, q) => q.occupants(p.resources ?? [], p.time as FocusTime) },
]

/** A part has content: a non-empty list, or a time. */
export function hasPart(p: Parts, k: PartName): boolean {
  const v = p[k]
  return v !== null && (!Array.isArray(v) || v.length > 0)
}

/** The parts a gesture fixes: the given ones that have content. */
export function fixedOf(parts: Partial<Parts>): Focus {
  const f: Focus = { ...EMPTY_FOCUS, ...parts, fixed: new Set(), pending: new Set() }
  const fixed = new Set<PartName>()
  for (const k of PART_NAMES) {
    if (hasPart(f, k)) fixed.add(k)
    else (f as Parts)[k] = null
  }
  return { ...f, fixed }
}

/** One propagation pass from the fixed parts of `start`. The `blocked` parts stay empty
 * (cleared by the user). `step` sees each intermediate focus (a part pending, then
 * written); `stale` stops the pass when a newer gesture replaced it. Returns the final
 * focus. */
export async function propagate(start: Focus, q: FocusQueries, step?: (f: Focus) => void,
  stale?: () => boolean, blocked: ReadonlySet<PartName> = new Set()): Promise<Focus> {
  let f: Focus = { ...start, pending: new Set() }
  const written = new Set<PartName>([...f.fixed, ...blocked])
  for (;;) {
    const edge = EDGES.find((e) => !written.has(e.to) && e.from.every((k) => written.has(k) && hasPart(f, k)))
    if (!edge) break
    written.add(edge.to)
    const pending = new Set<PartName>([edge.to])
    step?.({ ...f, pending })
    const value = await edge.run(f, q)
    if (stale?.()) return f
    f = { ...f, [edge.to]: value ?? null, pending: new Set() }
    step?.(f)
  }
  return f
}

/** Equal times. */
export function sameTime(x: FocusTime | null, y: FocusTime | null): boolean {
  if (x === y) return true
  if (!x || !y) return false
  if ('t' in x) return 't' in y && x.t === y.t
  return 'a' in y && x.a === y.a && x.b === y.b
}

export const itemKey = (i: FocusItem) => `${i.map}\u0000${i.program}\u0000${i.id}`
