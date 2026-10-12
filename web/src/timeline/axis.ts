// The time axis of the timeline and of the Instant tab's scrubber (views-design 6.1): the
// visible window, the range selection, the right-drag zoom box and the pinned cursor, with
// the drawing of the axis strip (ticks, range length, playhead handle) and of the bands and
// cursor lines over a plot area.
import type { Theme } from '../theme/theme'
import { clampViewport, fit, formatCycles, tickStep, zoomAt, type Viewport } from './viewport'
import { count } from '../ui/format'

export const GUTTER = 300   // label column width (CSS px); the plot starts here
export const AXIS = 28      // axis strip height

export interface Range {
  a: number
  b: number
}

const HANDLE_W = 11         // playhead handle (CSS px)
const HANDLE_H = 14

export class TimeAxis {
  view: Viewport = { t0: 0, cpp: 1 }
  /** canvas width in CSS px (the plot is [GUTTER, width)) */
  width = 1
  readonly endTime: number
  /** The range selection [a, b), or the one being dragged. */
  selection: Range | null = null
  /** Right-drag zoom preview. */
  zoomBox: Range | null = null
  /** The pinned cursor time of the shared state (the playhead). */
  pinned: number | null = null
  /** Called after every view change. */
  onView: (() => void) | null = null
  /** A window shown before the first resize. */
  private pending: Range | null = null

  constructor(endTime: number) {
    this.endTime = endTime
  }

  get plotWidth(): number {
    return Math.max(1, this.width - GUTTER)
  }

  /** The visible window [a, b) in cycles. */
  get window(): Range {
    return { a: this.view.t0, b: this.view.t0 + this.plotWidth * this.view.cpp }
  }

  resize(width: number): void {
    const first = this.width <= 1
    this.width = width
    if (first) {
      // A window set by another view before this one had a size: keep it, else fit.
      const w = this.pending
      this.view = w ? { t0: w.a, cpp: (w.b - w.a) / this.plotWidth } : fit(this.plotWidth, this.endTime)
      this.pending = null
    }
    this.setView(this.view)
  }

  setView(v: Viewport): void {
    this.view = clampViewport(v, this.plotWidth, this.endTime)
    this.onView?.()
  }

  /** Shows the window [a, b) set by another view of the same store; false if the view
   * already shows it (to within a pixel at each end). */
  showWindow(a: number, b: number): boolean {
    if (this.width <= 1) this.pending = { a, b }
    const w = this.window
    const px = this.view.cpp
    if (Math.abs(w.a - a) < px && Math.abs(w.b - b) < px) return false
    this.setView({ t0: a, cpp: (b - a) / this.plotWidth })
    return true
  }

  zoom(xPlot: number, factor: number): void {
    this.setView(zoomAt(this.view, xPlot, factor))
  }

  pan(dxPx: number): void {
    this.setView({ t0: this.view.t0 + dxPx * this.view.cpp, cpp: this.view.cpp })
  }

  zoomTo(r: Range): void {
    const a = Math.min(r.a, r.b)
    const b = Math.max(r.a, r.b)
    if (b - a <= 0) return
    this.setView({ t0: a, cpp: (b - a) / this.plotWidth })
  }

  timeAtX(x: number): number {
    return this.view.t0 + (x - GUTTER) * this.view.cpp
  }

  xOf(t: number): number {
    return GUTTER + (t - this.view.t0) / this.view.cpp
  }

  /** The playhead handle is under (x, y) (in the axis strip). */
  onHandle(x: number, y: number): boolean {
    if (this.pinned === null || y > AXIS) return false
    return Math.abs(x - this.xOf(this.pinned)) <= HANDLE_W / 2 + 2
  }

  /** The axis strip: ticks and labels, the end of the run, the length of the selection
   * (or of the zoom box being dragged) and the playhead handle. */
  drawAxis(ctx: CanvasRenderingContext2D, th: Theme, label = 'cycles'): void {
    const pw = this.plotWidth
    const step = tickStep(this.view.cpp, 90)
    ctx.fillStyle = th.surface
    ctx.fillRect(0, 0, this.width, AXIS)
    ctx.fillStyle = th.axis
    ctx.fillRect(0, AXIS - 1, this.width, 1)
    ctx.fillStyle = th.inkMuted
    ctx.font = `${th.fontSizeXs}px ${th.fontSans}`
    ctx.textBaseline = 'middle'
    ctx.fillText(label, 10, AXIS / 2)
    ctx.save()
    ctx.beginPath()
    ctx.rect(GUTTER, 0, pw, AXIS)
    ctx.clip()
    ctx.fillStyle = th.inkSecondary
    for (let t = Math.ceil(this.view.t0 / step) * step; t < this.view.t0 + pw * this.view.cpp; t += step) {
      const x = Math.round(this.xOf(t))
      ctx.fillRect(x, AXIS - 6, 1, 5)
      ctx.fillText(formatCycles(t, step), x + 4, AXIS / 2 - 1)
    }
    ctx.fillStyle = th.inkMuted
    ctx.fillRect(Math.round(this.xOf(this.endTime)), 0, 1, AXIS)
    const r = this.zoomBox ?? this.selection
    if (r) {
      const a = Math.min(r.a, r.b)
      const b = Math.max(r.a, r.b)
      const xa = this.xOf(a)
      const xb = this.xOf(b)
      const text = `${count(b - a)} cycles`
      ctx.font = `600 ${th.fontSizeXs}px ${th.fontSans}`
      const w = ctx.measureText(text).width + 10
      const cx = Math.max(GUTTER + w / 2, Math.min(this.width - w / 2, (xa + xb) / 2))
      ctx.fillStyle = th.accent
      ctx.fillRect(Math.max(GUTTER, xa), AXIS - 3, Math.max(1, Math.min(this.width, xb) - Math.max(GUTTER, xa)), 3)
      ctx.fillStyle = th.surfaceRaised
      ctx.fillRect(cx - w / 2, 3, w, AXIS - 8)
      ctx.fillStyle = th.ink
      ctx.textAlign = 'center'
      ctx.fillText(text, cx, AXIS / 2 - 1)
      ctx.textAlign = 'left'
    }
    // The playhead: a handle on the axis over the pinned time.
    if (this.pinned !== null) {
      const x = Math.round(this.xOf(this.pinned))
      ctx.fillStyle = th.accent
      ctx.fillRect(x - 1, 0, 2, AXIS)
      ctx.beginPath()
      ctx.moveTo(x - HANDLE_W / 2, 1)
      ctx.lineTo(x + HANDLE_W / 2, 1)
      ctx.lineTo(x + HANDLE_W / 2, HANDLE_H - 4)
      ctx.lineTo(x, HANDLE_H)
      ctx.lineTo(x - HANDLE_W / 2, HANDLE_H - 4)
      ctx.closePath()
      ctx.fill()
    }
    ctx.restore()
  }

  /** The selection band and the zoom box over the plot area [top, bottom). */
  drawBands(ctx: CanvasRenderingContext2D, th: Theme, top: number, bottom: number): void {
    ctx.save()
    ctx.beginPath()
    ctx.rect(GUTTER, top, this.plotWidth, bottom - top)
    ctx.clip()
    this.band(ctx, this.selection, th.accentArea, th.accent, top, bottom)
    this.band(ctx, this.zoomBox, th.hover, th.accent, top, bottom)
    ctx.restore()
  }

  /** The pinned time (a 2 px accent line) and the hover cursor (1 px) over [top, bottom). */
  drawCursor(ctx: CanvasRenderingContext2D, th: Theme, top: number, bottom: number, hoverX: number | null): void {
    if (this.pinned !== null) {
      const x = Math.round(this.xOf(this.pinned))
      if (x >= GUTTER && x <= this.width) {
        ctx.fillStyle = th.accent
        ctx.fillRect(x - 1, top, 2, bottom - top)
      }
    }
    if (hoverX === null || hoverX < GUTTER) return
    ctx.fillStyle = th.inkMuted
    ctx.fillRect(Math.round(hoverX), top, 1, bottom - top)
  }

  private band(ctx: CanvasRenderingContext2D, r: Range | null, fill: string, edge: string, top: number, bottom: number): void {
    if (!r) return
    const a = this.xOf(Math.min(r.a, r.b))
    const b = this.xOf(Math.max(r.a, r.b))
    ctx.fillStyle = fill
    ctx.fillRect(a, top, Math.max(1, b - a), bottom - top)
    ctx.fillStyle = edge
    ctx.fillRect(Math.round(a), top, 1, bottom - top)
    ctx.fillRect(Math.round(b), top, 1, bottom - top)
  }
}
