// Traffic view renderer (views-design Section 3): hierarchy columns, buses as vertical
// boxes, one strip per link colored by class with the load as lightness, a >>> pattern on
// links that carried traffic in one direction only over the run, levels of detail on y.
import type { ChargeCache } from '../data/charges'
import type { Trace } from '../data/trace'
import type { Theme } from '../theme/theme'
import { isDict } from '../data/columns'
import { recorded, type Recorded } from '../timeline/rows'
import { rgba } from '../timeline/raster'
import { chargesAmount, rangeAmount } from '../timeline/util'
import { layout, type Layout, type PLink } from './layout'
import { CLASS_ORDER, type LinkClass } from './model'
import { TrafficModel } from './model'

export const FULL_ROW_PX = 20       // a level is drawn in full when its rows get this height
const LABEL_W = 64                  // node names of the bands
const STRIP_PX = 5
const MAX_TOOLTIP_GROUPS = 8
const CLASS_SLOT: Record<LinkClass, string> = { global: 'global-2', local: 'local-0', control: 'control-2' }

export interface LinkLoad {
  util: number          // 0..1 of the ceiling (busier direction, or summed over members)
  rate: number          // units per cycle of that direction (or summed)
  exact: boolean
  charged: boolean      // any charge in the range
}

export class TrafficRenderer {
  readonly trace: Trace
  readonly model: TrafficModel
  readonly rec: Recorded
  readonly charges: ChargeCache
  theme: Theme
  width = 1
  height = 1
  /** full-layout px per row (the zoom), and the scroll offset in px */
  rowPx = 20
  scroll = 0
  range = { a: 0, b: 1 }
  show: Record<LinkClass, boolean> = { global: true, local: true, control: true }
  hoverKey: string | null = null
  readonly stats = { drawMs: [] as number[] }
  private readonly layouts = new Map<number, Layout>()
  private readonly bidir: Map<number, boolean>  // resource -> carried traffic over the run
  private current: { lay: Layout; px: number } | null = null
  private loads = new Map<string, LinkLoad>()
  private loadsKey = ''

  constructor(trace: Trace, charges: ChargeCache, theme: Theme) {
    this.trace = trace
    this.charges = charges
    this.theme = theme
    this.model = new TrafficModel(trace)
    this.rec = recorded(trace)
    this.bidir = new Map(trace.dims.resources.map((r) => [r.id as number, (r.amount as number) > 0]))
  }

  private lay(level: number): Layout {
    let l = this.layouts.get(level)
    if (!l) {
      l = layout(this.model, level)
      this.layouts.set(level, l)
    }
    return l
  }

  /** The layout for the zoom: the deepest level whose rows get FULL_ROW_PX, keeping the
   * total height of the full layout. */
  pick(): { lay: Layout; px: number } {
    const full = this.lay(this.model.depth)
    const total = full.units * this.rowPx
    for (let level = this.model.depth; level >= 0; level--) {
      const l = this.lay(level)
      const px = total / l.units
      if (px >= FULL_ROW_PX || level === 0) return { lay: l, px: level === this.model.depth ? this.rowPx : px }
    }
    return { lay: full, px: this.rowPx }
  }

  resize(w: number, h: number): void {
    const first = this.width <= 1
    this.width = w
    this.height = h
    if (first) this.fit()
  }

  fit(): void {
    this.rowPx = Math.max(4, (this.height - 20) / this.lay(this.model.depth).units)
    this.scroll = 0
  }

  zoomAt(y: number, factor: number): void {
    const before = (y + this.scroll) / this.rowPx
    this.rowPx = Math.max(2, Math.min(200, this.rowPx * factor))
    this.scroll = before * this.rowPx - y
    this.clampScroll()
  }

  scrollBy(dy: number): void {
    this.scroll += dy
    this.clampScroll()
  }

  private clampScroll(): void {
    const total = this.lay(this.model.depth).units * this.rowPx + 20
    this.scroll = Math.max(0, Math.min(Math.max(0, total - this.height), this.scroll))
  }

  /** The range the loads average over, clipped to the run. */
  setRange(a: number, b: number): void {
    const end = this.trace.manifest.end_time
    const lo = Math.max(0, Math.min(a, end - 1))
    this.range = { a: lo, b: Math.max(lo + 1, Math.min(b, end)) }
  }

  // ---- loads ----------------------------------------------------------------------------

  /** Average rate of a resource over the range: bins, and charges at partial bins when
   * they are loaded (they are requested otherwise). */
  private rate(resource: number): { value: number; exact: boolean } {
    const row = this.trace.levels.rowOf[resource]
    // A dump with a time window: the average over the part of the range it recorded.
    const w = this.rec.window
    const a = w ? Math.max(this.range.a, w[0]) : this.range.a
    const b = w ? Math.min(this.range.b, w[1]) : this.range.b
    if (row < 0 || b <= a) return { value: 0, exact: true }
    const edge = (x: number, y: number): number | null => {
      const out = []
      for (const blk of this.charges.groupsFor(x, y)) {
        const g = this.charges.peek(blk.group)
        if (!g) { void this.charges.get(blk); return null }
        out.push(g)
      }
      return chargesAmount(out, resource, x, y)
    }
    const r = rangeAmount(this.trace.levels, row, a, b, edge)
    return { value: r.amount / (b - a), exact: r.exact }
  }

  load(l: PLink): LinkLoad {
    const key = `${this.range.a}|${this.range.b}`
    if (key !== this.loadsKey) { this.loads.clear(); this.loadsKey = key }
    let v = this.loads.get(l.key)
    if (v) return v
    const res = this.trace.dims.resources
    const ceil = (r: number) => (res[r].ceiling as number | null) ?? 0
    if (l.kind === 'cross' || l.kind === 'self') {
      let amount = 0
      let cap = 0
      let exact = true
      for (const r of l.members) {
        const x = this.rate(r)
        amount += x.value
        cap += ceil(r)
        exact &&= x.exact
      }
      v = { util: cap > 0 ? amount / cap : 0, rate: amount, exact, charged: amount > 0 }
    } else {
      v = { util: 0, rate: 0, exact: true, charged: false }
      for (const r of [...directionSet(l, 0), ...directionSet(l, 1)]) {
        const x = this.rate(r)
        const u = ceil(r) > 0 ? x.value / ceil(r) : 0
        if (x.value > 0) v.charged = true
        v.exact &&= x.exact
        if (u >= v.util) { v.util = u; v.rate = x.value }
      }
    }
    this.loads.set(l.key, v)
    return v
  }

  /** Tooltip lines of a link: per direction (or summed) the rate and the % of ceiling. */
  detail(l: PLink): string[] {
    const res = this.trace.dims.resources
    const unit = (r: number) => String(res[r].unit ?? '')
    const fmt = (rate: number, cap: number, u: string) =>
      `${num(rate)} ${u}/cycle${cap > 0 ? ` · ${(100 * rate / cap).toFixed(1)} % of ${num(cap)} ${u}/cycle` : ''}`
    if (l.kind === 'cross' || l.kind === 'self') {
      const v = this.load(l)
      const cap = l.members.reduce((acc, r) => acc + ((res[r].ceiling as number | null) ?? 0), 0)
      return [`${l.members.length} resources, summed: ${fmt(v.rate, cap, unit(l.members[0]))}${v.exact ? '' : ' (approx.)'}`]
    }
    const out: string[] = []
    const line = (r: number, head: string) => {
      const x = this.rate(r)
      out.push(`${head}: ${fmt(x.value, (res[r].ceiling as number | null) ?? 0, unit(r))}${x.exact ? '' : ' (approx.)'}`)
    }
    if (l.kind === 'att') {
      if (l.fwd !== null) line(l.fwd, 'in (to the bus)')
      if (l.rev !== null) line(l.rev, 'out (from the bus)')
      return out
    }
    // A link: per direction the MAX over the link direction and the two ports it passes.
    for (const k of [0, 1] as const) {
      out.push(k === 0 ? 'up (to the parent):' : 'down (to the child):')
      for (const r of directionSet(l, k)) line(r, `  ${String(res[r].name)}`)
    }
    out.push('color: the largest % of these')
    return out
  }

  /** forward, reverse or both: the directions that carried traffic over the whole run. */
  direction(l: PLink): 'both' | 'fwd' | 'rev' | 'none' {
    if (l.kind === 'cross' || l.kind === 'self') return 'both'
    const f = directionSet(l, 0).some((x) => this.bidir.get(x))
    const r = directionSet(l, 1).some((x) => this.bidir.get(x))
    return f && r ? 'both' : f ? 'fwd' : r ? 'rev' : 'none'
  }

  /** The record type of the link's charges was filtered out of the dump, the link is
   * outside the recorded subtrees, or the range is outside the recorded window. */
  notRecorded(l: PLink): boolean {
    if (!(l.cls === 'control' ? this.rec.messages : this.rec.charges)) return true
    // An aggregated row counts as recorded if a node below it is.
    if (l.kind === 'cross' || l.kind === 'self' ? !this.anyRecordedBelow(l.node) : !this.rec.inTree[l.node]) return true
    const w = this.rec.window
    return !!w && (this.range.b <= w[0] || this.range.a >= w[1])
  }

  private anyRecordedBelow(node: number): boolean {
    const visit = (id: number): boolean => this.model.nodes[id].children.some((c) => this.rec.inTree[c] || visit(c))
    return visit(node)
  }

  /** The task kinds with the most amount on the link in the range (message kinds for
   * protocol messages), or null when the charges of the range are not loaded (they are
   * requested if the range needs at most MAX_TOOLTIP_GROUPS row groups). */
  topKinds(l: PLink, n = 4): { name: string; share: number }[] | 'loading' | 'too long' {
    const { a, b } = this.range
    const blocks = this.charges.groupsFor(a, b)
    if (blocks.length > MAX_TOOLTIP_GROUPS) return 'too long'
    const groups = []
    for (const blk of blocks) {
      const g = this.charges.peek(blk.group)
      if (g) groups.push(g)
      else void this.charges.get(blk)
    }
    if (groups.length < blocks.length) return 'loading'
    const resources = l.kind === 'cross' || l.kind === 'self' ? l.members : [...directionSet(l, 0), ...directionSet(l, 1)]
    const by = new Map<string, number>()
    let total = 0
    for (const g of groups) {
      const c = g.table.cols
      const start = c.start as Float64Array
      const end = c.end as Float64Array
      const amount = c.amount as Float64Array
      const gid = c.gid as Float64Array | Int32Array
      const msg = c.msg as Float64Array | Int32Array
      for (const r of resources) {
        for (let i = g.from[r]; i < g.to[r]; i++) {
          const s = start[i]
          const e = end[i]
          if (s >= b) break
          const part = e === s ? (s >= a ? 1 : 0) : Math.max(0, Math.min(e, b) - Math.max(s, a)) / (e - s)
          if (part <= 0) continue
          const v = amount[i] * part
          const name = this.kindOf(gid[i], msg[i])
          by.set(name, (by.get(name) ?? 0) + v)
          total += v
        }
      }
    }
    return [...by].sort((x, y) => y[1] - x[1]).slice(0, n).map(([name, v]) => ({ name, share: total > 0 ? v / total : 0 }))
  }

  private kindOf(gid: number, msg: number): string {
    if (gid >= 0) {
      const row = this.taskRow(gid)
      if (row < 0) return 'tasks not in the tasks table'
      const kind = this.trace.facts.tasks.cols.kind
      if (kind && isDict(kind) && kind.codes[row] >= 0) return kind.dict[kind.codes[row]]
      const op = (this.trace.facts.tasks.cols.opcode as Int32Array)[row]
      return String(this.trace.dims.opcodes[op]?.name ?? `opcode ${op}`)
    }
    if (msg >= 0) return `message ${String(this.trace.dims.message_kinds[msg]?.name ?? msg)}`
    return 'load, store or program'
  }

  private taskRow(gid: number): number {
    const a = this.trace.facts.tasks.cols.gid as Int32Array
    let lo = 0
    let hi = a.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (a[mid] < gid) lo = mid + 1
      else hi = mid
    }
    return lo < a.length && a[lo] === gid ? lo : -1
  }

  // ---- drawing --------------------------------------------------------------------------

  draw(ctx: CanvasRenderingContext2D, dpr: number): void {
    const t0 = performance.now()
    const th = this.theme
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = th.surface
    ctx.fillRect(0, 0, this.width, this.height)
    const pick = this.pick()
    this.current = pick
    const { lay, px } = pick
    const colW = (this.width - LABEL_W - 16) / lay.cols
    const X = (x: number) => 8 + LABEL_W + x * colW
    const Y = (y: number) => 10 + y * px - this.scroll
    ctx.textBaseline = 'middle'
    // Bands of the nodes: a rule under each band of the deepest drawn level, and the
    // node names in the left gutter (the parent's name at its first child).
    ctx.font = `${th.fontSizeXs}px ${th.fontSans}`
    ctx.textAlign = 'left'
    const deepest = lay.aggs.length ? lay.level : this.model.depth
    for (const b of lay.bands) {
      const y0 = Y(b.y0)
      const y1 = Y(b.y1)
      if (y1 < 0 || y0 > this.height) continue
      if (b.depth === deepest) {
        ctx.fillStyle = th.grid
        ctx.fillRect(0, y1 - 0.5, this.width, 1)
        const name = b.label.split('.').slice(1).join('.') || b.label
        ctx.fillStyle = th.inkSecondary
        clip(ctx, name, 6, Math.max(y0 + 8, Math.min(y1 - 8, (y0 + y1) / 2)), LABEL_W - 8)
      }
    }
    // Aggregated rows.
    for (const g of lay.aggs) {
      const y0 = Y(g.y0)
      const y1 = Y(g.y1)
      ctx.fillStyle = th.page
      ctx.fillRect(X(g.x0), y0, X(g.x1) - X(g.x0), y1 - y0)
      ctx.strokeStyle = th.axis
      ctx.lineWidth = 1
      ctx.strokeRect(X(g.x0) + 0.5, y0 + 0.5, X(g.x1) - X(g.x0) - 1, y1 - y0 - 1)
      ctx.fillStyle = th.ink
      ctx.font = `600 ${th.fontSizeS}px ${th.fontSans}`
      clip(ctx, g.label, X(g.x0) + 8, (y0 + y1) / 2, X(g.x1) - X(g.x0) - 40)
    }
    // Links under the boxes.
    for (const l of lay.links) {
      if (!this.show[l.cls]) continue
      this.drawLink(ctx, l, X, Y, px)
    }
    // Buses.
    ctx.font = `${th.fontSizeXs}px ${th.fontSans}`
    for (const b of lay.buses) {
      if (!this.show[b.cls]) continue
      const x = X(b.x)
      const y0 = Y(b.y0)
      const y1 = Y(b.y1)
      if (y1 < 0 || y0 > this.height) continue
      ctx.fillStyle = th.surfaceRaised
      ctx.fillRect(x - 5, y0, 10, y1 - y0)
      ctx.strokeStyle = this.classColor(b.cls)
      ctx.lineWidth = 1.5
      ctx.strokeRect(x - 5 + 0.5, y0 + 0.5, 9, y1 - y0 - 1)
      ctx.save()
      ctx.translate(x, Math.max(y0, 0) + Math.min(y1 - Math.max(y0, 0), 200) / 2)
      ctx.rotate(-Math.PI / 2)
      ctx.fillStyle = th.inkSecondary
      ctx.textAlign = 'center'
      if (y1 - y0 > 40) ctx.fillText(b.label, 0, 0)
      ctx.restore()
    }
    // Blocks.
    for (const b of lay.blocks) {
      const y = Y(b.y)
      const h = Math.min(px * 0.8, 22)
      if (y + h < 0 || y - h > this.height) continue
      ctx.fillStyle = th.surfaceRaised
      ctx.fillRect(X(b.x0), y - h / 2, X(b.x1) - X(b.x0), h)
      ctx.strokeStyle = th.axis
      ctx.lineWidth = 1
      ctx.strokeRect(X(b.x0) + 0.5, y - h / 2 + 0.5, X(b.x1) - X(b.x0) - 1, h - 1)
      if (h >= 10) {
        ctx.fillStyle = th.ink
        ctx.font = `${th.fontSizeXs}px ${th.fontSans}`
        clip(ctx, b.label, X(b.x0) + 5, y, X(b.x1) - X(b.x0) - 8)
      }
    }
    this.stats.drawMs.push(performance.now() - t0)
    if (this.stats.drawMs.length > 2000) this.stats.drawMs.splice(0, 1000)
  }

  classColor(cls: LinkClass): string {
    return this.theme.lines[CLASS_SLOT[cls]] ?? this.theme.accent
  }

  /** The class color at a load: a lightness ramp from a pale tint (0 %) to the full class
   * color (100 %). */
  rampColor(cls: LinkClass, u: number): string {
    const c = rgba(this.classColor(cls))
    const s = rgba(this.theme.surface)
    const t = 0.25 + 0.75 * Math.max(0, Math.min(1, u))
    const mix = (i: number) => Math.round(s[i] + (c[i] - s[i]) * t)
    return `rgb(${mix(0)}, ${mix(1)}, ${mix(2)})`
  }

  private drawLink(ctx: CanvasRenderingContext2D, l: PLink, X: (x: number) => number, Y: (y: number) => number, px: number): void {
    const th = this.theme
    const x0 = X(l.x0)
    const x1 = X(l.x1)
    const y0 = Y(l.y0)
    const y1 = Y(l.y1)
    if (Math.max(y0, y1) < -20 || Math.min(y0, y1) > this.height + 20) return
    const w = Math.max(2, Math.min(STRIP_PX, px * 0.18))
    const hovered = this.hoverKey === l.key
    if (this.notRecorded(l)) {
      ctx.strokeStyle = th.inkMuted
      ctx.setLineDash([2, 3])
      ctx.lineWidth = 1
      this.path(ctx, l, x0, y0, x1, y1)
      ctx.stroke()
      ctx.setLineDash([])
      return
    }
    const v = this.load(l)
    if (!v.charged) {
      ctx.strokeStyle = th.axis
      ctx.lineWidth = hovered ? 2 : 1
      this.path(ctx, l, x0, y0, x1, y1)
      ctx.stroke()
      return
    }
    ctx.strokeStyle = this.rampColor(l.cls, v.util)
    ctx.lineWidth = hovered ? w + 2 : w
    ctx.lineCap = 'butt'
    this.path(ctx, l, x0, y0, x1, y1)
    ctx.stroke()
    const dir = this.direction(l)
    if ((dir === 'fwd' || dir === 'rev') && l.kind !== 'self') {
      // >>> chevrons in the direction of the traffic.
      const len = Math.hypot(x1 - x0, y1 - y0)
      const ux = (x1 - x0) / len
      const uy = (y1 - y0) / len
      const s = dir === 'fwd' ? 1 : -1
      ctx.strokeStyle = th.surface
      ctx.lineWidth = 1.2
      ctx.beginPath()
      for (let d = 8; d < len - 6; d += 9) {
        const cx = x0 + ux * d
        const cy = y0 + uy * d
        const a = w * 0.5
        ctx.moveTo(cx - s * ux * a - uy * a, cy - s * uy * a + ux * a)
        ctx.lineTo(cx + s * ux * a * 0.6, cy + s * uy * a * 0.6)
        ctx.lineTo(cx - s * ux * a + uy * a, cy - s * uy * a - ux * a)
      }
      ctx.stroke()
    }
  }

  /** The path of a link: a straight strip, or for a self link a loop out of the
   * aggregated row's end and back (nested per class: control inside, global outside). */
  private path(ctx: CanvasRenderingContext2D, l: PLink, x0: number, y0: number, x1: number, y1: number): void {
    ctx.beginPath()
    if (l.kind === 'self') {
      const { r, s } = loopSize(l.cls)
      ctx.moveTo(x0, y0 - s)
      ctx.bezierCurveTo(x0 + r, y0 - s - r * 0.5, x0 + r, y0 + s + r * 0.5, x0, y0 + s)
      return
    }
    ctx.moveTo(x0, y0)
    ctx.lineTo(x1, y1)
  }

  /** The link under (x, y), or null. */
  linkAt(x: number, y: number): PLink | null {
    const cur = this.current
    if (!cur) return null
    const { lay, px } = cur
    const colW = (this.width - LABEL_W - 16) / lay.cols
    const X = (v: number) => 8 + LABEL_W + v * colW
    const Y = (v: number) => 10 + v * px - this.scroll
    let best: PLink | null = null
    let bestD = 6
    for (const l of lay.links) {
      if (!this.show[l.cls]) continue
      let dist: number
      if (l.kind === 'self') {
        // Distance to the loop's tip (its rightmost point, 0.75 r from the row's end).
        const { r } = loopSize(l.cls)
        dist = Math.hypot(x - (X(l.x0) + 0.75 * r), (y - Y(l.y0)) * 0.5)
      } else dist = segDist(x, y, X(l.x0), Y(l.y0), X(l.x1), Y(l.y1))
      if (dist < bestD) { best = l; bestD = dist }
    }
    return best
  }

  get level(): number {
    return this.current?.lay.level ?? this.model.depth
  }
}

/** The resources of one direction of an attachment or link (0 = forward). */
function directionSet(l: PLink, k: 0 | 1): number[] {
  const main = k === 0 ? l.fwd : l.rev
  return [...(main === null ? [] : [main]), ...(k === 0 ? l.fwdPorts : l.revPorts)]
}

/** Self loop size per class: reach r to the right and half-height s at the row's end. */
function loopSize(cls: LinkClass): { r: number; s: number } {
  const k = CLASS_ORDER.indexOf(cls)
  return { r: 16 + 12 * k, s: 2 + 2 * k }
}

function num(v: number): string {
  return v.toFixed(v >= 100 || Number.isInteger(v) ? 0 : v >= 10 ? 1 : 2)
}

function segDist(px: number, py: number, x0: number, y0: number, x1: number, y1: number): number {
  const dx = x1 - x0
  const dy = y1 - y0
  const t = Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / (dx * dx + dy * dy || 1)))
  return Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy))
}

function clip(ctx: CanvasRenderingContext2D, s: string, x: number, y: number, max: number): void {
  if (max <= 6) return
  if (ctx.measureText(s).width <= max) { ctx.fillText(s, x, y); return }
  let lo = 0
  let hi = s.length
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (ctx.measureText(`${s.slice(0, mid)}…`).width <= max) lo = mid
    else hi = mid - 1
  }
  if (lo > 0) ctx.fillText(`${s.slice(0, lo)}…`, x, y)
}
