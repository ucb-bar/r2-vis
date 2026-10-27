// Time input of the timeline (views-design 6.1, 7): a drag on the plot or the axis selects
// a range, a click on the plot or the axis an instant (the focus time, state/focusctl.ts),
// the playhead handle drags (scrubs) the instant, right-drag zooms to a box, ctrl+wheel or
// pinch zooms, horizontal or shift+wheel pans, a double-click on the axis fits the time
// (the home window) and restores the focus from before its clicks.
import type { Focus, FocusTime } from '../state/focus'
import type { ViewStore } from '../state/viewstore'
import { AXIS, GUTTER, type TimeAxis } from './axis'
import { zoomFactor } from './viewport'

export const DRAG_PX = 3
/** A click on the axis followed by a double-click within this time is a fit, not a cursor. */
const DOUBLE_MS = 600

export interface TimeInputHost {
  axis: TimeAxis
  store: ViewStore
  /** Redraw. */
  changed(): void
  /** A time gesture: an instant (a click, a scrub) or a range (a drag; `done` false while
   * it runs). `y0`: where it started (above AXIS: on the axis); `alt`: alt was held. */
  time(t: FocusTime, at: { y0: number; alt: boolean; done: boolean }): void
  /** A left click without a drag on the plot (not the axis); true if the host used it
   * (else the click selects an instant). */
  plotClick?(x: number, y: number, e: PointerEvent): boolean
  /** A right click without a drag on the plot. */
  plotRightClick?(x: number, y: number): void
}

interface Drag {
  kind: 'select' | 'axis' | 'zoom' | 'scrub'
  x0: number
  y0: number
  t0: number
  moved: boolean
  alt: boolean
}

export class TimeInput {
  private readonly host: TimeInputHost
  private drag: Drag | null = null
  /** The focus before the last click on the axis (a double-click restores it). */
  private beforeClick: { at: number; focus: Focus } | null = null

  constructor(host: TimeInputHost) {
    this.host = host
  }

  get dragging(): boolean {
    return this.drag !== null
  }

  /** The cursor style for a pointer at (x, y) when no drag runs. */
  cursorAt(x: number, y: number): string | null {
    if (x < GUTTER) return null
    if (this.host.axis.onHandle(x, y)) return 'ew-resize'
    return y < AXIS ? 'pointer' : null
  }

  /** Takes a pointer down at (x, y); false if it is not a time gesture (labels). */
  down(e: PointerEvent, x: number, y: number): boolean {
    if (x < GUTTER) return false
    const axis = this.host.axis
    const t0 = axis.timeAtX(x)
    const at = { x0: x, y0: y, t0, moved: false, alt: e.altKey }
    if (e.button === 0 && axis.onHandle(x, y)) this.drag = { kind: 'scrub', ...at }
    else if (e.button === 0) this.drag = { kind: y < AXIS ? 'axis' : 'select', ...at }
    else if (e.button === 2) this.drag = { kind: 'zoom', ...at }
    else return false
    return true
  }

  /** A pointer move during a drag; false if no time drag runs. A scrub moves the instant
   * and keeps the other fixed parts of the focus. */
  move(x: number): boolean {
    const d = this.drag
    if (!d) return false
    const axis = this.host.axis
    const xc = Math.max(GUTTER, Math.min(axis.width, x))
    if (d.kind === 'scrub') {
      d.moved = true
      this.host.time({ t: Math.max(0, Math.min(axis.endTime, axis.timeAtX(xc))) }, { y0: 0, alt: true, done: false })
      this.host.changed()
      return true
    }
    if (!d.moved && Math.abs(x - d.x0) <= DRAG_PX) return true
    d.moved = true
    const r = { a: d.t0, b: axis.timeAtX(xc) }
    if (d.kind === 'zoom') axis.zoomBox = r
    else {
      axis.selection = { a: Math.min(r.a, r.b), b: Math.max(r.a, r.b) }
      if (axis.selection.b > axis.selection.a) this.host.time({ ...axis.selection }, { y0: d.y0, alt: d.alt, done: false })
    }
    this.host.changed()
    return true
  }

  /** The end of a drag; false if no time drag ran. */
  up(e: PointerEvent, x: number, y: number): boolean {
    const d = this.drag
    this.drag = null
    if (!d) return false
    const { axis, store } = this.host
    const instant = () => ({ t: Math.max(0, Math.min(axis.endTime, axis.timeAtX(x))) })
    if (d.kind === 'select' || d.kind === 'axis') {
      if (!d.moved || !axis.selection || axis.selection.b <= axis.selection.a) {
        // A click selects an instant there, unless the host takes a click on the plot (a
        // task bar selects its task).
        if (d.kind === 'axis' || !this.host.plotClick?.(x, y, e)) {
          if (d.kind === 'axis') this.beforeClick = { at: performance.now(), focus: store.focus.get() }
          axis.selection = null
          this.host.time(instant(), { y0: d.y0, alt: d.alt, done: true })
        }
      } else this.host.time({ ...axis.selection }, { y0: d.y0, alt: d.alt, done: true })
    } else if (d.kind === 'scrub') {
      if (d.moved) this.host.time(instant(), { y0: 0, alt: true, done: true })
    } else if (d.kind === 'zoom') {
      if (d.moved && axis.zoomBox) axis.zoomTo(axis.zoomBox)
      else this.host.plotRightClick?.(x, y)
      axis.zoomBox = null
    }
    this.host.changed()
    return true
  }

  /** A wheel event at x; true if it zoomed or panned (the caller prevents the default). */
  wheel(e: WheelEvent, x: number, pageHeight: number): boolean {
    const horizontal = !e.ctrlKey && (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY))
    if (!horizontal && !e.ctrlKey) return false   // a plain vertical wheel scrolls (rows)
    const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? pageHeight : 1
    const axis = this.host.axis
    if (horizontal) axis.pan((e.shiftKey && e.deltaX === 0 ? e.deltaY : e.deltaX) * scale)
    else axis.zoom(Math.max(0, x - GUTTER), zoomFactor(e.deltaY * scale))
    this.host.changed()
    return true
  }

  /** A double-click at (x, y): on the axis, the home window (the recorded window of a
   * windowed dump, else the run), with the cursor and range as before its clicks; true if
   * it was on the axis. */
  double(x: number, y: number): boolean {
    if (x < GUTTER || y >= AXIS) return false
    const { axis, store } = this.host
    const b = this.beforeClick
    this.beforeClick = null
    if (b && performance.now() - b.at < DOUBLE_MS) store.focus.restore(b.focus)
    axis.zoomTo(axis.home)
    this.host.changed()
    return true
  }

}
