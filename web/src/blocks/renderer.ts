// Block diagram renderer: one canvas, boxes back to front, three levels of detail by the
// box's size on screen (views-design Section 2).
import { programSpans } from '../data/programs'
import type { Trace } from '../data/trace'
import type { BlockSelection } from '../state/blocks'
import type { TimeRange } from '../state/viewstore'
import type { Theme } from '../theme/theme'
import { pct } from '../ui/format'
import { recordedPart } from '../timeline/rows'
import { boxAt, layout, type Box } from './layout'
import { BlockMetrics, type TrafficClass } from './metrics'

export const FILL_ONLY_PX = 24      // under this height: a filled box
export const NAME_W_PX = 120        // under this size: the name only
export const NAME_H_PX = 80
const HEADER_PX = 22
const STRIP_LABEL_PX = 112   // label on the left, the window average right-aligned
const STRIP_MAX_PX = 40
const TOGGLE_PX = 12

export interface Camera {
  s: number      // CSS px per world unit
  ox: number
  oy: number
}

type StripKind = 'programs' | 'tensor' | 'vector' | TrafficClass

const STRIP_LABEL: Record<StripKind, string> = {
  programs: 'programs', tensor: 'tensor', vector: 'vector',
  global: 'global', local: 'local', control: 'control',
}

/** Line color slot of a strip (the timeline's line families). */
const STRIP_LINE: Record<Exclude<StripKind, 'programs'>, string> = {
  tensor: 'tensor', vector: 'vector', global: 'global-2', local: 'local-0', control: 'control-2',
}

export class BlockRenderer {
  readonly trace: Trace
  readonly blocks: BlockSelection
  readonly metrics: BlockMetrics
  root: Box
  aspect = 1.6
  cam: Camera = { s: 1, ox: 0, oy: 0 }
  width = 1
  height = 1
  window: TimeRange
  theme: Theme
  hoverNode: number | null = null
  readonly stats = { drawMs: [] as number[] }
  /** Toggle rectangles of the last frame (CSS px): node -> [x, y, size]. */
  readonly toggles = new Map<number, [number, number, number]>()
  private readonly cache = new Map<string, { ok: boolean; v: Float64Array }>()
  private readonly stripCache = new Map<number, StripKind[]>()
  private readonly avgCache = new Map<string, number>()
  private readonly programsOf: Map<number, { start: number; end: number; name: string }[]>

  constructor(trace: Trace, blocks: BlockSelection, window: TimeRange, theme: Theme) {
    this.trace = trace
    this.blocks = blocks
    this.window = window
    this.theme = theme
    this.metrics = new BlockMetrics(trace)
    this.root = layout(trace, this.aspect)
    this.programsOf = programSpans(trace)
  }

  resize(width: number, height: number): void {
    const first = this.width <= 1
    this.width = width
    this.height = height
    const aspect = Math.max(0.5, Math.min(3, width / Math.max(1, height)))
    if (first || Math.abs(aspect - this.aspect) > 0.15) {
      this.aspect = aspect
      this.root = layout(this.trace, aspect)
      this.fit(this.root)
    }
  }

  setWindow(w: TimeRange): void {
    this.window = w
    if (this.cache.size > 400) this.cache.clear()
    if (this.avgCache.size > 2000) this.avgCache.clear()
  }

  /** Camera that shows `box` with a margin. */
  fit(box: Box): void {
    const s = 0.94 * Math.min(this.width / box.w, this.height / box.h)
    this.cam = { s, ox: (this.width - box.w * s) / 2 - box.x * s, oy: (this.height - box.h * s) / 2 - box.y * s }
  }

  zoomAt(x: number, y: number, factor: number): void {
    const c = this.cam
    const s = Math.max(0.05, Math.min(5000, c.s * factor))
    const k = s / c.s
    this.cam = { s, ox: x - (x - c.ox) * k, oy: y - (y - c.oy) * k }
  }

  pan(dx: number, dy: number): void {
    this.cam = { ...this.cam, ox: this.cam.ox + dx, oy: this.cam.oy + dy }
  }

  boxAtScreen(x: number, y: number): Box | null {
    return boxAt(this.root, (x - this.cam.ox) / this.cam.s, (y - this.cam.oy) / this.cam.s)
  }

  toggleAt(x: number, y: number): number | null {
    for (const [node, [tx, ty, size]] of this.toggles) {
      if (x >= tx - 3 && x <= tx + size + 3 && y >= ty - 3 && y <= ty + size + 3) return node
    }
    return null
  }

  draw(ctx: CanvasRenderingContext2D, dpr: number): void {
    const t0 = performance.now()
    const th = this.theme
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = th.page
    ctx.fillRect(0, 0, this.width, this.height)
    this.toggles.clear()
    this.drawBox(ctx, this.root)
    this.stats.drawMs.push(performance.now() - t0)
    if (this.stats.drawMs.length > 2000) this.stats.drawMs.splice(0, 1000)
  }

  private screen(b: Box): { x: number; y: number; w: number; h: number } {
    const c = this.cam
    return { x: b.x * c.s + c.ox, y: b.y * c.s + c.oy, w: b.w * c.s, h: b.h * c.s }
  }

  /** The box is drawn with its strips (their values are on screen). */
  showsStrips(b: Box): boolean {
    const r = this.screen(b)
    if (r.h < FILL_ONLY_PX || r.w < NAME_W_PX || r.h < NAME_H_PX) return false
    const strips = this.stripsOf(b.node)
    const room = (b.band * this.cam.s - HEADER_PX - 6) / strips.length
    return strips.length > 0 && (b.children.length ? Math.min(STRIP_MAX_PX, room) : room) >= 10
  }

  private drawBox(ctx: CanvasRenderingContext2D, b: Box): void {
    const th = this.theme
    const r = this.screen(b)
    if (r.x > this.width || r.y > this.height || r.x + r.w < 0 || r.y + r.h < 0) return
    const hovered = this.hoverNode === b.node
    if (r.h < FILL_ONLY_PX) {
      // Smallest level: a box filled by its compute utilization over the window.
      const u = this.average(b.node)
      ctx.fillStyle = u === u ? th.seq[Math.min(th.seq.length - 1, Math.floor(u * th.seq.length))] : th.grid
      ctx.fillRect(r.x, r.y, r.w, r.h)
      if (hovered) this.outline(ctx, r, th.ink, 1.5)
      return
    }
    ctx.fillStyle = th.surface
    ctx.fillRect(r.x, r.y, r.w, r.h)
    this.outline(ctx, r, hovered ? th.ink : th.axis, hovered ? 1.5 : 1)
    ctx.font = `600 ${th.fontSizeS}px ${th.fontSans}`
    ctx.textBaseline = 'middle'
    if (r.w < NAME_W_PX || r.h < NAME_H_PX) {
      // Middle level: the name only (and the timeline toggle if there is room).
      ctx.fillStyle = th.ink
      ctx.textAlign = 'center'
      clipText(ctx, b.name, r.x + r.w / 2, r.y + r.h / 2, r.w - 8)
      ctx.textAlign = 'left'
      if (r.w > 48 && r.h > 30) this.toggle(ctx, b.node, r.x + r.w - TOGGLE_PX - 5, r.y + 5)
      return
    }
    // Largest level: header, strips, children.
    ctx.fillStyle = th.ink
    clipText(ctx, b.path, r.x + 8, r.y + HEADER_PX / 2 + 1, r.w - 40)
    this.toggle(ctx, b.node, r.x + r.w - TOGGLE_PX - 6, r.y + (HEADER_PX - TOGGLE_PX) / 2 + 1)
    const band = b.band * this.cam.s
    const stripsTop = r.y + HEADER_PX
    const strips = this.stripsOf(b.node)
    // A leaf box gives its strips the full height; a box with children caps them.
    const room = (band - HEADER_PX - 6) / strips.length
    const stripH = b.children.length ? Math.min(STRIP_MAX_PX, room) : room
    if (stripH >= 10) {
      strips.forEach((k, i) => this.drawStrip(ctx, b, k, r.x + 6, stripsTop + i * stripH, r.w - 12, stripH - 3))
    }
    for (const c of b.children) this.drawBox(ctx, c)
  }

  private outline(ctx: CanvasRenderingContext2D, r: { x: number; y: number; w: number; h: number }, color: string, width: number): void {
    ctx.strokeStyle = color
    ctx.lineWidth = width
    ctx.strokeRect(Math.round(r.x) + 0.5, Math.round(r.y) + 0.5, Math.round(r.w) - 1, Math.round(r.h) - 1)
  }

  private toggle(ctx: CanvasRenderingContext2D, node: number, x: number, y: number): void {
    const th = this.theme
    const on = this.blocks.has(node)
    ctx.fillStyle = on ? th.accent : th.surface
    ctx.fillRect(x, y, TOGGLE_PX, TOGGLE_PX)
    ctx.strokeStyle = on ? th.accent : th.inkMuted
    ctx.lineWidth = 1
    ctx.strokeRect(x + 0.5, y + 0.5, TOGGLE_PX - 1, TOGGLE_PX - 1)
    if (on) {
      ctx.strokeStyle = th.accentInk
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(x + 3, y + 6.5)
      ctx.lineTo(x + 5.5, y + 9)
      ctx.lineTo(x + 9.5, y + 3.5)
      ctx.stroke()
    }
    this.toggles.set(node, [x, y, TOGGLE_PX])
  }

  /** Strips of a box: programs, tensor, vector, then the traffic classes at the node. */
  private stripsOf(node: number): StripKind[] {
    let s = this.stripCache.get(node)
    if (!s) {
      s = ['programs', 'tensor', 'vector', ...this.metrics.classesAt(node)]
      this.stripCache.set(node, s)
    }
    return s
  }

  private drawStrip(ctx: CanvasRenderingContext2D, b: Box, kind: StripKind, x: number, y: number, w: number, h: number): void {
    const th = this.theme
    ctx.font = `${th.fontSizeXs}px ${th.fontSans}`
    ctx.fillStyle = th.inkMuted
    ctx.textBaseline = 'middle'
    clipText(ctx, STRIP_LABEL[kind], x, y + h / 2, STRIP_LABEL_PX - 46)
    const cx = x + STRIP_LABEL_PX
    const cw = w - STRIP_LABEL_PX
    if (cw < 8) return
    ctx.fillStyle = th.page
    ctx.fillRect(cx, y, cw, h)
    if (kind === 'programs') {
      this.drawPrograms(ctx, b.node, cx, y, cw, h)
      return
    }
    const n = samples(cw)
    const { ok, v } = this.series(b.node, kind, n)
    if (!ok) {
      ctx.fillStyle = th.inkMuted
      ctx.fillText('none', cx + 4, y + h / 2)
      return
    }
    // Area and line of the 0..1 series, with the 100 % line on top.
    const yOf = (u: number) => y + h - Math.min(1, Math.max(0, u)) * (h - 2)
    const path = new Path2D()
    for (let k = 0; k < n; k++) {
      const px = cx + ((k + 0.5) / n) * cw
      if (k === 0) path.moveTo(px, yOf(v[k]))
      else path.lineTo(px, yOf(v[k]))
    }
    const area = new Path2D(path)
    area.lineTo(cx + cw, y + h)
    area.lineTo(cx, y + h)
    area.closePath()
    const color = th.lines[STRIP_LINE[kind]] ?? th.accent
    ctx.fillStyle = color
    ctx.globalAlpha = 0.18
    ctx.fill(area)
    ctx.globalAlpha = 1
    ctx.strokeStyle = color
    ctx.lineWidth = 1.25
    ctx.stroke(path)
    // A windowed dump: the time outside the recording greyed; the label is the average over
    // the recorded part.
    const { a: t0, b: t1 } = this.window
    const rec = recordedPart(this.metrics.window, t0, t1)
    const win = this.metrics.window
    if (win) {
      const xOf = (t: number) => cx + Math.max(0, Math.min(1, (t - t0) / (t1 - t0))) * cw
      ctx.fillStyle = th.page
      ctx.globalAlpha = 0.7
      ctx.fillRect(cx, y, xOf(win[0]) - cx, h)
      ctx.fillRect(xOf(win[1]), y, cx + cw - xOf(win[1]), h)
      ctx.globalAlpha = 1
    }
    ctx.fillStyle = th.inkSecondary
    ctx.textAlign = 'right'
    ctx.fillText(rec ? pct(this.series(b.node, kind, 1, rec).v[0]) : 'not recorded', x + STRIP_LABEL_PX - 8, y + h / 2)
    ctx.textAlign = 'left'
  }

  private drawPrograms(ctx: CanvasRenderingContext2D, node: number, x: number, y: number, w: number, h: number): void {
    const th = this.theme
    const progs = this.programsOf.get(node) ?? []
    const { a, b } = this.window
    const span = b - a
    ctx.save()
    ctx.beginPath()
    ctx.rect(x, y, w, h)
    ctx.clip()
    for (const p of progs) {
      const l = x + ((p.start - a) / span) * w
      const r = x + ((p.end - a) / span) * w
      if (r < x || l > x + w) continue
      ctx.fillStyle = th.grid
      ctx.fillRect(l, y + 2, Math.max(1, r - l), h - 4)
      const cl = Math.max(l, x) + 4
      const cr = Math.min(r, x + w) - 4
      if (cr - cl > 24) {
        ctx.fillStyle = th.inkSecondary
        clipText(ctx, p.name, cl, y + h / 2, cr - cl)
      }
    }
    ctx.restore()
  }

  private series(node: number, kind: Exclude<StripKind, 'programs'>, n: number, range?: { a: number; b: number }):
    { ok: boolean; v: Float64Array } {
    const { a, b } = range ?? this.window
    const key = `${node}|${kind}|${n}|${a}|${b}`
    let hit = this.cache.get(key)
    if (!hit) {
      const v = new Float64Array(n)
      const m = this.metrics
      const ok = kind === 'tensor' ? m.tensor(node, a, b, n, v) : kind === 'vector' ? m.vector(node, a, b, n, v)
        : m.traffic(node, kind, a, b, n, v)
      hit = { ok, v }
      this.cache.set(key, hit)
    }
    return hit
  }

  private average(node: number): number {
    const { a, b } = this.window
    const key = `${node}|${a}|${b}`
    let v = this.avgCache.get(key)
    if (v === undefined) {
      v = this.metrics.computeAverage(node, a, b)
      this.avgCache.set(key, v)
    }
    return v
  }
}

/** Samples of a strip: a power of two, at most the pixel width, at most 512. */
function samples(px: number): number {
  let n = 8
  while (n * 2 <= Math.min(512, px)) n *= 2
  return n
}

function clipText(ctx: CanvasRenderingContext2D, s: string, x: number, y: number, max: number): void {
  if (max <= 4) return
  if (ctx.measureText(s).width <= max) {
    ctx.fillText(s, x, y)
    return
  }
  let lo = 0
  let hi = s.length
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (ctx.measureText(`${s.slice(0, mid)}…`).width <= max) lo = mid
    else hi = mid - 1
  }
  if (lo > 0) ctx.fillText(`${s.slice(0, lo)}…`, x, y)
}

