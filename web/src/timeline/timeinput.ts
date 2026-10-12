// Time input shared by the timeline and the Instant scrubber (views-design 6.1, 7): a drag
// on the plot or the axis selects a range, a click on the plot or the axis sets the cursor
// there (the two exclude each other), the playhead handle drags (scrubs) the cursor,
// right-drag zooms to a box, ctrl+wheel or pinch zooms, horizontal or shift+wheel pans, a
// double-click on the axis fits the time (the home window), Esc clears the range and the
// cursor.
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
  /** The axis selection changed: publish it to the store. */
  rangeChanged(): void
  /** A left click without a drag on the plot (not the axis); true if the host used it
   * (else the click sets the cursor). */
  plotClick?(x: number, y: number, e: PointerEvent): boolean
  /** A right click without a drag on the plot. */
  plotRightClick?(x: number, y: number): void
}

interface Drag {
  kind: 'select' | 'axis' | 'zoom' | 'scrub'
  x0: number
  t0: number
  moved: boolean
}

export class TimeInput {
  private readonly host: TimeInputHost
  private drag: Drag | null = null
  /** The cursor and range before the last click on the axis (a double-click restores them). */
  private beforeClick: { at: number; cursor: ReturnType<ViewStore['cursor']['get']>; range: { a: number; b: number } | null } | null = null

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
    if (e.button === 0 && axis.onHandle(x, y)) this.drag = { kind: 'scrub', x0: x, t0, moved: false }
    else if (e.button === 0) this.drag = { kind: y < AXIS ? 'axis' : 'select', x0: x, t0, moved: false }
    else if (e.button === 2) this.drag = { kind: 'zoom', x0: x, t0, moved: false }
    else return false
    return true
  }

  /** A pointer move during a drag; false if no time drag runs. */
  move(x: number): boolean {
    const d = this.drag
    if (!d) return false
    const axis = this.host.axis
    const xc = Math.max(GUTTER, Math.min(axis.width, x))
    if (d.kind === 'scrub') {
      d.moved = true
      this.host.store.pin(Math.max(0, Math.min(axis.endTime, axis.timeAtX(xc))))
      this.host.changed()
      return true
    }
    if (!d.moved && Math.abs(x - d.x0) <= DRAG_PX) return true
    d.moved = true
    const r = { a: d.t0, b: axis.timeAtX(xc) }
    if (d.kind === 'zoom') axis.zoomBox = r
    else {
      axis.selection = { a: Math.min(r.a, r.b), b: Math.max(r.a, r.b) }
      this.host.rangeChanged()
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
    if (d.kind === 'select' || d.kind === 'axis') {
      if (!d.moved) {
        // A click sets the cursor there (it clears the range), unless the host takes a
        // click on the plot (a task bar toggles its task).
        if (d.kind === 'axis' || !this.host.plotClick?.(x, y, e)) {
          if (d.kind === 'axis') {
            this.beforeClick = { at: performance.now(), cursor: store.cursor.get(), range: axis.selection ? { ...axis.selection } : null }
          }
          axis.selection = null
          this.host.rangeChanged()
          store.pin(Math.max(0, Math.min(axis.endTime, axis.timeAtX(x))))
        }
      } else {
        // A drag sets the range (it clears the cursor).
        if (axis.selection && axis.selection.b - axis.selection.a <= 0) axis.selection = null
        this.host.rangeChanged()
      }
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
    if (b && performance.now() - b.at < DOUBLE_MS) {
      axis.selection = b.range
      this.host.rangeChanged()
      if (!b.range) store.cursor.set(b.cursor)
    }
    axis.zoomTo(axis.home)
    this.host.changed()
    return true
  }

  /** Esc: clears the zoom box, the range and the cursor; true if there was either. */
  escape(): boolean {
    const { axis, store } = this.host
    axis.zoomBox = null
    const had = !!axis.selection || !!store.cursor.get()
    if (axis.selection) {
      axis.selection = null
      this.host.rangeChanged()
    }
    if (store.cursor.get()) store.unpin()
    this.host.changed()
    return had
  }
}
