// The state that all views share (views-design Sections 1 and 7): the timeline's time
// window, the cursor (an instant, set by a click) or the range selection (set by a drag),
// which exclude each other, the task selection and smoothing. Each Timeline area has its
// own node set (state/workbench.ts); `targetBlocks` is the one the block diagram edits.
import { BlockSelection } from './blocks'
import { Store } from './store'

export interface TimeRange {
  a: number
  b: number
  /** the timeline window only: cycles per pixel (smoothing at the cursor uses it) */
  cpp?: number
}

export interface Cursor {
  t: number
  pinned: boolean
}

export class ViewStore {
  readonly window: Store<TimeRange>
  readonly range = new Store<TimeRange | null>(null)
  readonly cursor = new Store<Cursor | null>(null)
  readonly smoothing = new Store<number>(1)
  /** Selected tasks (task rows): their dependency arrows stay shown. Not persisted. */
  readonly tasks = new Store<ReadonlySet<number>>(new Set())
  /** A request to show a task (task row) in the timeline and select it: the timeline
   * scrolls and pans to it, the workspace switches to the timeline. */
  readonly reveal = new Store<number | null>(null)
  /** The node set of the target timeline (the block diagram shows and edits it). */
  readonly targetBlocks: Store<BlockSelection>
  readonly endTime: number

  /** `home`: the window shown first (the recorded window of a windowed dump) */
  constructor(nodeIds: number[], endTime: number, home?: TimeRange) {
    this.targetBlocks = new Store(new BlockSelection(nodeIds))
    this.endTime = endTime
    this.window = new Store<TimeRange>(home ?? { a: 0, b: endTime })
    // The cursor and the range exclude each other: setting one clears the other.
    this.cursor.subscribe((c) => { if (c && this.range.get()) this.range.set(null) })
    this.range.subscribe((r) => { if (r && this.cursor.get()) this.cursor.set(null) })
  }

  /** The node set of the target timeline. */
  get blocks(): BlockSelection {
    return this.targetBlocks.get()
  }

  /** What an instant view shows: the cursor, else the range, else the window. */
  active(): { kind: 'cursor' | 'range' | 'window'; a: number; b: number } {
    const c = this.cursor.get()
    if (c) return { kind: 'cursor', a: c.t, b: c.t }
    const r = this.range.get()
    if (r && r.b > r.a) return { kind: 'range', ...r }
    return { kind: 'window', ...this.window.get() }
  }

  /** The time range an instant view averages over, clipped to the run: the range or
   * window, or at the cursor the smoothing width (smoothing px of the timeline, at least
   * one cycle). */
  activeRange(): { kind: 'cursor' | 'range' | 'window'; a: number; b: number } {
    const act = this.active()
    const w = act.kind === 'cursor' ? Math.max(1, this.smoothing.get() * (this.window.get().cpp ?? 1)) : 0
    const a = Math.max(0, Math.min(act.a - w / 2, this.endTime - 1))
    return { kind: act.kind, a, b: Math.max(a + 1, Math.min(act.b + w / 2, this.endTime)) }
  }

  /** Sets the cursor (a click on a plot or on the axis): an instant; it clears the range. */
  pin(t: number): void {
    this.cursor.set({ t, pinned: true })
  }

  unpin(): void {
    this.cursor.set(null)
  }
}

/** Equal ranges (both null, or the same bounds). */
export function sameRange(x: TimeRange | null, y: TimeRange | null): boolean {
  return x === y || (!!x && !!y && x.a === y.a && x.b === y.b)
}

/** Toggles one task in the task selection. */
/** Selects only `task` (a plain click on its bar). */
export function selectTask(store: ViewStore, task: number): void {
  const cur = store.tasks.get()
  if (cur.size !== 1 || !cur.has(task)) store.tasks.set(new Set([task]))
}

/** Adds or removes `task` (shift, ctrl or cmd + click on its bar). */
export function toggleTask(store: ViewStore, task: number): void {
  const next = new Set(store.tasks.get())
  if (next.has(task)) next.delete(task)
  else next.add(task)
  store.tasks.set(next)
}
