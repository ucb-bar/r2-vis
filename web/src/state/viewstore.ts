// The state that all views share (views-design Sections 1 and 7): the timeline's time
// window, the focus (state/focusctl.ts: the tasks, time, resources and source items
// selected) and smoothing. Each Timeline area has its own node set (state/workbench.ts);
// `targetBlocks` is the one the block diagram edits.
import type { LoadedMap } from '../source/links'
import { BlockSelection } from './blocks'
import { sameTime, type FocusTime } from './focus'
import { FocusControl } from './focusctl'
import { Store } from './store'

export interface TimeRange {
  a: number
  b: number
  /** the timeline window only: cycles per pixel (smoothing at the cursor uses it) */
  cpp?: number
}

export class ViewStore {
  readonly window: Store<TimeRange>
  readonly smoothing = new Store<number>(1)
  /** The selection of all views. */
  readonly focus = new FocusControl()
  /** The attribution scope: node ids (their subtrees); empty: the whole device. Forward
   * attribution counts only occupants inside it. Global, not part of the focus. */
  readonly scope = new Store<ReadonlySet<number>>(new Set())
  /** A request to show a task (task row) in the timeline: the timeline scrolls and pans to
   * it, the workspace switches to the timeline. */
  readonly reveal = new Store<number | null>(null)
  /** The loaded source maps (the app's; set when they change). */
  readonly sourceMaps = new Store<LoadedMap[]>([])
  /** A request to show a task's item (by its pc) in a Source area (state/workbench.ts). */
  readonly showSource = new Store<number | null>(null)
  /** The node set of the target timeline (the block diagram shows and edits it). */
  readonly targetBlocks: Store<BlockSelection>
  readonly endTime: number

  /** `home`: the window shown first (the recorded window of a windowed dump) */
  constructor(nodeIds: number[], endTime: number, home?: TimeRange) {
    this.targetBlocks = new Store(new BlockSelection(nodeIds))
    this.endTime = endTime
    this.window = new Store<TimeRange>(home ?? { a: 0, b: endTime })
  }

  /** The node set of the target timeline. */
  get blocks(): BlockSelection {
    return this.targetBlocks.get()
  }

  /** The time of the focus. */
  get time(): FocusTime | null {
    return this.focus.get().time
  }

  /** Calls `f` when the focus time changes. */
  onTime(f: (t: FocusTime | null) => void): () => void {
    let last = this.time
    return this.focus.subscribe((v) => { if (!sameTime(v.time, last)) { last = v.time; f(v.time) } })
  }

  /** What an instant view shows: the focus instant, else its range, else the window. */
  active(): { kind: 'cursor' | 'range' | 'window'; a: number; b: number } {
    const t = this.time
    if (t && 't' in t) return { kind: 'cursor', a: t.t, b: t.t }
    if (t && t.b > t.a) return { kind: 'range', a: t.a, b: t.b }
    return { kind: 'window', ...this.window.get() }
  }

  /** The time range an instant view averages over, clipped to the run: the range or
   * window, or at the instant the smoothing width (smoothing px of the timeline, at least
   * one cycle). */
  activeRange(): { kind: 'cursor' | 'range' | 'window'; a: number; b: number } {
    const act = this.active()
    const w = act.kind === 'cursor' ? Math.max(1, this.smoothing.get() * (this.window.get().cpp ?? 1)) : 0
    const a = Math.max(0, Math.min(act.a - w / 2, this.endTime - 1))
    return { kind: act.kind, a, b: Math.max(a + 1, Math.min(act.b + w / 2, this.endTime)) }
  }
}
