// Traffic view renderer (views-design Sections 3 and 6.2): hierarchy columns, buses as
// vertical boxes, one strip per link in its class color, as wide as its bandwidth, with a
// pattern that moves at its utilization (chevrons on a one-way link, two stripe halves on a
// duplex link), levels of detail on y.
import type { ChargeCache } from '../data/charges'
import type { Trace } from '../data/trace'
import type { Theme } from '../theme/theme'
import { isDict } from '../data/columns'
import { recorded, type Recorded } from '../timeline/rows'
import { rgba } from '../timeline/raster'
import { chargesAmount, rangeAmount } from '../timeline/util'
import { columns, layout, LOOP_LEG, type Layout, type PLink } from './layout'
import type { LinkClass } from './model'
import { TrafficModel } from './model'

const LABEL_MIN = 64                // the gutter of the band names: at least, and at most a
const LABEL_MAX = 0.3               // fraction of the view's width
const BUS_HALF = 9                  // half width of a bus box
const STRIP_H = 18                  // strip height (px) without the bandwidth scale: fits the text
const SCALED_MAX = 24               // the widest strip (px) with the bandwidth scale (square root)
const SLOT_GAP = 6                  // px between the strips of a box
const BOX_PAD = 5                   // px between a box's edge and its outer strips
const BOX_GAP = 4                   // px between neighboring boxes of a column
const MIN_BOX = 22                  // the smallest box height (px), for its label
const TEXT_UP = 1                   // px over the theme's sizes: the view's texts are a little larger
const LOOP_MIN_LEN = 56             // the shortest loop leg (px)
const LOOP_MARGIN = 14              // px between a hairpin's end and the next bus column
const BUS_COL_WEIGHT = 1.3          // relative widths of the bus and block columns
const BLOCK_COL_WEIGHT = 0.75
const OUTLINE_MIN_W = 5             // unlimited links: a dashed outline from this width
const MAX_SPEED = 80                // pattern speed at 100 % (px/s)
const TINT = 0.35                   // the pattern: the class color mixed with white
const MAX_TOOLTIP_GROUPS = 8
const CLASS_SLOT: Record<LinkClass, string> = { global: 'global-2', local: 'local-0', control: 'control-2' }

/** A drawn link: a strip body [a, b) (between its droplet ends), a thin line, or one leg
 * of a loop. */
interface Strip {
  link: PLink
  kind: 'bar' | 'line' | 'leg'
  a: number
  b: number
  y: number
  w: number
  /** uni: chevrons of one direction (a loop leg: stripes); still: stripes, no motion */
  mode: 'uni' | 'still'
  /** pattern speed along +x (px/s) */
  vTop: number
  vBot: number
  pointsRight?: boolean
  unlimited: boolean
  /** the direction its text shows (uni strips and loop legs) */
  dir: 0 | 1
}

/** A block's or aggregated row's box, and a bus box, in px. */
interface Box {
  x0: number
  x1: number
  y0: number
  y1: number
  label: string
  agg: boolean
}

interface BusBox {
  x: number
  y0: number
  y1: number
  label: string
  cls: LinkClass
}

export interface ClassOptions {
  visible: boolean
  collapse: boolean
}

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
  private themeValue: Theme
  width = 1
  height = 1
  /** full-layout px per row (the zoom), and the scroll offset in px */
  rowPx = 20
  scroll = 0
  range = { a: 0, b: 1 }
  /** per class: visible (the layout leaves hidden classes out), and collapse when no
   * traffic (a link with no traffic in the range is a thin line) */
  classes: Record<LinkClass, ClassOptions> = {
    global: { visible: true, collapse: true }, local: { visible: true, collapse: true }, control: { visible: true, collapse: true },
  }
  hoverKey: string | null = null
  /** square-root strip widths by bandwidth (no text), else fixed heights with text */
  scaleByBandwidth = false
  readonly stats = { drawMs: [] as number[], animMs: [] as number[], texts: 0, shortTexts: 0, noTexts: 0 }
  private strips: Strip[] = []
  private boxes: Box[] = []
  private busBoxes: BusBox[] = []
  private readonly patterns = new Map<string, { pattern: CanvasPattern; period: number }>()
  private dpr = 1
  private readonly layouts = new Map<string, Layout>()
  private labelW: { font: string; w: number } | null = null
  private readonly minRows = new WeakMap<Layout, { pitch: number; need: number }>()
  private readonly bidir: Map<number, boolean>  // resource -> carried traffic over the run
  private current: { lay: Layout; px: number } | null = null
  private loads = new Map<string, LinkLoad>()
  private loadsKey = ''

  constructor(trace: Trace, charges: ChargeCache, theme: Theme) {
    this.trace = trace
    this.charges = charges
    this.themeValue = theme
    this.model = new TrafficModel(trace)
    this.rec = recorded(trace)
    this.bidir = new Map(trace.dims.resources.map((r) => [r.id as number, (r.amount as number) > 0]))
  }

  private lay(level: number): Layout {
    const visible = { global: this.classes.global.visible, local: this.classes.local.visible, control: this.classes.control.visible }
    const key = `${level}|${+visible.global}${+visible.local}${+visible.control}`
    let l = this.layouts.get(key)
    if (!l) {
      l = layout(this.model, level, visible)
      this.layouts.set(key, l)
    }
    return l
  }

  /** The layout for the zoom: the deepest level whose rows are tall enough for the boxes
   * to take their strips (minRowPx), keeping the total height of the full layout. */
  pick(): { lay: Layout; px: number } {
    const full = this.lay(this.model.depth)
    const total = full.units * this.rowPx
    for (let level = this.model.depth; level >= 0; level--) {
      const l = this.lay(level)
      const px = total / l.units
      if (px >= this.minRowPx(l) || level === 0) return { lay: l, px: level === this.model.depth ? this.rowPx : px }
    }
    return { lay: full, px: this.rowPx }
  }

  /** The row height (px) from which the full layout is drawn. */
  get fullRowPx(): number {
    return this.minRowPx(this.lay(this.model.depth))
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

  get theme(): Theme {
    return this.themeValue
  }

  set theme(t: Theme) {
    this.themeValue = t
    this.patterns.clear()
  }

  // ---- drawing (views-design 6.2, 6.4) --------------------------------------------------
  // Three layers: the base (background, bands, boxes of aggregated rows, strip bodies with
  // their droplet ends, the hairpin loops), the animation (the moving patterns: opaque tiles
  // clipped to the strip bodies and loop legs) and the top (buses and blocks over the
  // strips, texts, hover outline). Only the animation layer changes between frames.
  // Strips have fixed heights in screen pixels; the boxes are sized to the strips they take.

  /** The strip height of the unscaled mode, the largest of the scaled mode, and the slot
   * pitch (a strip and the gap to the next). */
  private get stripMax(): number {
    return this.scaleByBandwidth ? SCALED_MAX : STRIP_H
  }

  private get pitch(): number {
    return this.stripMax + SLOT_GAP
  }

  /** The height of a box with `slots` strips. */
  private boxHeight(slots: number): number {
    return Math.max(MIN_BOX, slots * this.pitch - SLOT_GAP + 2 * BOX_PAD)
  }

  /** The smallest row height (px) at which a layout's boxes fit their strips. */
  private minRowPx(l: Layout): number {
    const known = this.minRows.get(l)
    if (known?.pitch === this.pitch) return known.need
    let need = 0
    for (const b of l.blocks) need = Math.max(need, (this.boxHeight(b.slots) + BOX_GAP) / b.span)
    for (const g of l.aggs) need = Math.max(need, this.boxHeight(g.slots) / g.span)
    // The strips of a box and the strips of a link group that cross them (the links of a
    // node to its parent pass the other buses of their column): far enough apart.
    const span = (p: PLink) => [Math.min(p.x0, p.x1), Math.max(p.x0, p.x1)]
    const extent = (slots: number) => slots * this.pitch - SLOT_GAP
    const groups = l.links.filter((p) => p.kind === 'link' || p.kind === 'cross')
    for (const a of l.links) {
      if (a.kind !== 'att') continue
      const [a0, a1] = span(a)
      for (const g of groups) {
        const dy = Math.abs(a.yc - g.yc)
        const [g0, g1] = span(g)
        if (dy < 1e-6 || Math.min(a1, g1) - Math.max(a0, g0) < 0.05) continue
        need = Math.max(need, ((extent(a.slots) + extent(g.slots)) / 2 + SLOT_GAP) / dy)
      }
    }
    this.minRows.set(l, { pitch: this.pitch, need })
    return need
  }

  /** The bandwidth that sets a strip's width in the scaled mode, per direction: the rate
   * of the direction's resource (a port's or the link's), else its ceiling (the peak of an
   * unlimited link); an aggregated edge or loop leg sums its direction's members. */
  bandwidth(l: PLink, k: 0 | 1 = 0): { bw: number; unlimited: boolean } {
    const res = this.trace.dims.resources
    const one = (r: number): [number, boolean] => {
      const rate = res[r].rate as number | null
      return rate !== null ? [rate, false] : [(res[r].ceiling as number | null) ?? 0, true]
    }
    let bw = 0
    let unlimited = false
    const add = (rs: number[]) => {
      for (const r of rs) { const [v, u] = one(r); bw += v; unlimited ||= u }
    }
    if (l.kind === 'cross' || l.kind === 'self') add(k === 0 ? l.fwdMembers : l.revMembers)
    else {
      const main = k === 0 ? l.fwd : l.rev
      if (main !== null) [bw, unlimited] = one(main)
    }
    return { bw, unlimited }
  }

  /** Utilization and throughput of one direction (0 = forward: in, ab or up); an
   * aggregated edge or a loop sums its members of that direction. */
  dirLoad(l: PLink, k: 0 | 1): { util: number; rate: number } {
    const res = this.trace.dims.resources
    const ceil = (r: number) => (res[r].ceiling as number | null) ?? 0
    if (l.kind === 'cross' || l.kind === 'self') {
      let rate = 0
      let cap = 0
      for (const r of k === 0 ? l.fwdMembers : l.revMembers) { rate += this.rate(r).value; cap += ceil(r) }
      return { util: cap > 0 ? rate / cap : 0, rate }
    }
    let best = { util: 0, rate: 0 }
    for (const r of directionSet(l, k)) {
      const v = this.rate(r).value
      const u = ceil(r) > 0 ? v / ceil(r) : 0
      if (u >= best.util) best = { util: u, rate: v }
    }
    return best
  }

  private geometry(): { lay: Layout; px: number; X: (x: number) => number; Y: (y: number) => number; labelW: number } {
    const pick = this.pick()
    this.current = pick
    const { lay, px } = pick
    // Columns of unequal width: the bus columns wider (their strips carry text), the block
    // columns narrower.
    const { busCol } = columns(this.model.depth)
    const isBus = new Set(Array.from({ length: this.model.depth + 1 }, (_, d) => busCol(d)))
    const weight = Array.from({ length: lay.cols }, (_, i) => (isBus.has(i) ? BUS_COL_WEIGHT : BLOCK_COL_WEIGHT))
    const labelW = this.labelWidth()
    const unit = (this.width - labelW - 16) / weight.reduce((p, q) => p + q, 0)
    const start = [0]
    for (const w of weight) start.push(start[start.length - 1] + w * unit)
    const X = (x: number) => {
      const i = Math.max(0, Math.min(lay.cols - 1, Math.floor(x)))
      return 8 + labelW + start[i] + (x - i) * weight[i] * unit
    }
    return { lay, px, X, Y: (y: number) => 10 + y * px - this.scroll, labelW }
  }

  /** The node names of the bands (the path without the root's name). */
  private bandName(label: string): string {
    return label.split('.').slice(1).join('.') || label
  }

  /** The width of the gutter: the longest band name of the full layout (the same at every
   * level of detail, so the columns do not move when the level changes). */
  private labelWidth(): number {
    const font = `${this.theme.fontSizeXs + TEXT_UP}px ${this.theme.fontSans}`
    if (this.labelW?.font !== font) {
      const ctx = document.createElement('canvas').getContext('2d') as CanvasRenderingContext2D
      ctx.font = font
      const names = this.lay(this.model.depth).bands.filter((b) => b.depth > 0).map((b) => this.bandName(b.label))
      this.labelW = { font, w: Math.max(0, ...names.map((n) => ctx.measureText(n).width)) + 14 }
    }
    return Math.max(LABEL_MIN, Math.min(this.width * LABEL_MAX, this.labelW.w))
  }

  /** The y (px) of a slot of a box centered at row yc with `slots` slots. */
  private slotY(Y: (y: number) => number, yc: number, slot: number, slots: number): number {
    return Y(yc) + (slot - (slots - 1) / 2) * this.pitch
  }

  /** The base layer; it also lays out the strips, the boxes and the buses for the other
   * two layers and for hit tests. */
  drawBase(ctx: CanvasRenderingContext2D, dpr: number): void {
    const t0 = performance.now()
    const th = this.theme
    this.dpr = dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = th.surface
    ctx.fillRect(0, 0, this.width, this.height)
    const { lay, px, X, Y, labelW } = this.geometry()
    ctx.textBaseline = 'middle'
    // Bands of the nodes: a rule under each band of the deepest drawn level, and the
    // node names in the left gutter.
    ctx.font = `${th.fontSizeXs + TEXT_UP}px ${th.fontSans}`
    ctx.textAlign = 'left'
    const deepest = lay.aggs.length ? lay.level : this.model.depth
    for (const b of lay.bands) {
      const y0 = Y(b.y0)
      const y1 = Y(b.y1)
      if (y1 < 0 || y0 > this.height || b.depth !== deepest) continue
      ctx.fillStyle = th.grid
      ctx.fillRect(0, y1 - 0.5, this.width, 1)
      ctx.fillStyle = th.inkSecondary
      clip(ctx, this.bandName(b.label), 6, Math.max(y0 + 8, Math.min(y1 - 8, (y0 + y1) / 2)), labelW - 4)
    }
    // Boxes of the blocks and aggregated rows, sized to their strips (drawn on the top
    // layer; kept here for the hairpins, the texts and the hit tests).
    this.boxes = []
    for (const b of lay.blocks) {
      const h = this.boxHeight(b.slots)
      this.boxes.push({ x0: X(b.x0), x1: X(b.x1), y0: Y(b.y) - h / 2, y1: Y(b.y) + h / 2, label: b.label, agg: false })
    }
    for (const g of lay.aggs) {
      const h = this.boxHeight(g.slots)
      this.boxes.push({ x0: X(g.x0), x1: X(g.x1), y0: Y(g.y) - h / 2, y1: Y(g.y) + h / 2, label: g.label, agg: true })
    }
    // Strip widths: fixed, or the square root of the bandwidth (the widest link of the
    // drawn level at SCALED_MAX).
    const bwRef = Math.max(1e-9, ...lay.links.map((l) => Math.max(this.bandwidth(l, 0).bw, this.bandwidth(l, 1).bw)))
    const widthOf = (bw: number) => (this.scaleByBandwidth ? Math.max(3, SCALED_MAX * Math.sqrt(bw / bwRef)) : STRIP_H)
    this.strips = []
    const endY = new Map<number, { y: number; w: number }[]>()   // bus attachment -> strip ends
    for (const l of lay.links) {
      if (l.kind === 'self') {
        this.layoutLoop(ctx, l, X, Y, widthOf)
        continue
      }
      // A link with traffic in both directions over the run: two one-way strips (forward
      // on top); else one strip, of its direction (none: still).
      const dirs: (0 | 1 | null)[] = l.pair ? [0, 1] : [this.runBusy(l, 0) ? 0 : this.runBusy(l, 1) ? 1 : null]
      dirs.forEach((k, i) => {
        const y = this.slotY(Y, l.yc, l.slot + i, l.slots)
        const w = widthOf(this.bandwidth(l, k ?? 0).bw)
        for (const att of l.ends) endY.set(att, [...(endY.get(att) ?? []), { y, w }])
        if (y > -80 && y < this.height + 80) this.layoutStrip(ctx, l, X, y, w, k)
      })
    }
    // Buses: each spans the strips that end on it.
    this.busBoxes = []
    for (const b of lay.buses) {
      const ends = b.atts.flatMap((a) => endY.get(a) ?? [])
      if (!ends.length) continue
      this.busBoxes.push({ x: X(b.x), y0: Math.min(...ends.map((e) => e.y - e.w / 2)) - BOX_PAD,
        y1: Math.max(...ends.map((e) => e.y + e.w / 2)) + BOX_PAD, label: b.label, cls: b.cls })
    }
    void px
    this.stats.drawMs.push(performance.now() - t0)
    if (this.stats.drawMs.length > 2000) this.stats.drawMs.splice(0, 1000)
  }

  /** Traffic in direction k over the whole run (the layout and the pattern kind do not
   * change with the range). */
  private runBusy(l: PLink, k: 0 | 1): boolean {
    const rs = l.kind === 'cross' || l.kind === 'self' ? (k === 0 ? l.fwdMembers : l.revMembers) : directionSet(l, k)
    return rs.some((r) => this.bidir.get(r))
  }

  /** One strip of a link, of direction k (null: a link with no traffic over the run), from
   * x0 to x1 at y, w high: its body with a droplet flare at each end. A link with no traffic
   * in the range is a thin line in its class color when its class collapses, else a full
   * strip at 0 % with a still pattern; a link that the dump did not record is a dashed grey
   * line. */
  private layoutStrip(ctx: CanvasRenderingContext2D, l: PLink, X: (x: number) => number, y: number, w: number,
    k: 0 | 1 | null): void {
    const th = this.theme
    // The ends: a block's or aggregated row's edge, or the side of a bus box.
    let xa = X(l.x0)
    let xb = X(l.x1)
    const sgn = xb >= xa ? 1 : -1
    if (l.kind === 'link') xa += sgn * BUS_HALF
    xb -= sgn * BUS_HALF
    const a = Math.min(xa, xb)
    const b = Math.max(xa, xb)
    const recorded = !this.notRecorded(l)
    const charged = recorded && this.load(l).charged
    if (!recorded || (!charged && this.classes[l.cls].collapse)) {
      ctx.strokeStyle = recorded ? this.classColor(l.cls) : th.inkMuted
      ctx.lineWidth = recorded ? 1.5 : 1
      ctx.setLineDash(recorded ? [] : [2, 3])
      ctx.beginPath()
      ctx.moveTo(a, Math.round(y) + 0.5)
      ctx.lineTo(b, Math.round(y) + 0.5)
      ctx.stroke()
      ctx.setLineDash([])
      this.strips.push({ link: l, kind: 'line', a, b, y, w: 1, mode: 'still', vTop: 0, vBot: 0, unlimited: false, dir: k ?? 0 })
      return
    }
    const f = flare(w)
    ctx.fillStyle = this.classColor(l.cls)
    stripBody(ctx, a, b, y, w, f, true, true)
    ctx.fill()
    const { unlimited } = this.bandwidth(l, k ?? 0)
    // Forward (in, ab) runs from x0 to x1 on the screen.
    const fwdSign = X(l.x1) >= X(l.x0) ? 1 : -1
    const sign = k === 1 ? -fwdSign : fwdSign
    // No traffic in the range (the class does not collapse): a still pattern.
    const still = k === null || !charged
    const speed = still ? 0 : this.dirLoad(l, k).util * MAX_SPEED
    this.strips.push({ link: l, kind: 'bar', a: a + f, b: b - f, y, w, mode: still ? 'still' : 'uni',
      vTop: sign * speed, vBot: 0, pointsRight: sign > 0, unlimited, dir: k ?? 0 })
  }

  /** The loop of the links inside an aggregated row: a hairpin out of the row's edge, two
   * straight legs (top: forward, in / up; bottom: the return) joined by a semicircle. */
  private layoutLoop(ctx: CanvasRenderingContext2D, l: PLink, X: (x: number) => number, Y: (y: number) => number,
    widthOf: (bw: number) => number): void {
    const th = this.theme
    const xa = X(l.x0)
    const yt = this.slotY(Y, l.yc, l.slot, l.slots)
    const yb = this.slotY(Y, l.yc, l.slot + LOOP_LEG, l.slots)
    const wt = widthOf(this.bandwidth(l, 0).bw)
    const wb = widthOf(this.bandwidth(l, 1).bw)
    const r = (yb - yt) / 2
    // The legs reach to just before the bus column of the row's node.
    const len = Math.max(LOOP_MIN_LEN, X(l.x1) - xa - r - Math.max(wt, wb) / 2 - LOOP_MARGIN)
    const xe = xa + len
    const recorded = !this.notRecorded(l)
    const charged = recorded && this.load(l).charged
    if (!recorded || (!charged && this.classes[l.cls].collapse)) {
      ctx.strokeStyle = recorded ? this.classColor(l.cls) : th.inkMuted
      ctx.lineWidth = recorded ? 1.5 : 1
      ctx.setLineDash(recorded ? [] : [2, 3])
      hairpinPath(ctx, xa, xe, yt, yb)
      ctx.stroke()
      ctx.setLineDash([])
      this.strips.push({ link: l, kind: 'line', a: xa, b: xe + r, y: (yt + yb) / 2, w: yb - yt, mode: 'still', vTop: 0, vBot: 0, unlimited: false, dir: 0 })
      return
    }
    ctx.fillStyle = this.classColor(l.cls)
    // The legs with their flares at the row's edge, and the semicircle (a ring segment).
    const ft = flare(wt)
    const fb = flare(wb)
    stripBody(ctx, xa, xe, yt, wt, ft, true, false)
    ctx.fill()
    stripBody(ctx, xa, xe, yb, wb, fb, true, false)
    ctx.fill()
    ctx.beginPath()
    const outer = r + Math.max(wt, wb) / 2
    const inner = Math.max(0, r - Math.max(wt, wb) / 2)
    ctx.arc(xe, (yt + yb) / 2, outer, -Math.PI / 2, Math.PI / 2)
    ctx.arc(xe, (yt + yb) / 2, inner, Math.PI / 2, -Math.PI / 2, true)
    ctx.closePath()
    ctx.fill()
    const u0 = this.dirLoad(l, 0).util
    const u1 = this.dirLoad(l, 1).util
    // The top leg moves away from the row, the bottom leg back to it.
    this.strips.push({ link: l, kind: 'leg', a: xa + ft, b: xe, y: yt, w: wt, mode: 'uni', vTop: u0 * MAX_SPEED,
      vBot: 0, unlimited: this.bandwidth(l, 0).unlimited, dir: 0 })
    this.strips.push({ link: l, kind: 'leg', a: xa + fb, b: xe, y: yb, w: wb, mode: 'uni', vTop: -u1 * MAX_SPEED,
      vBot: 0, unlimited: this.bandwidth(l, 1).unlimited, dir: 1 })
  }

  /** The top layer: buses and blocks over the strips, the texts on the strips and the
   * hover outline (transparent elsewhere). */
  drawTop(ctx: CanvasRenderingContext2D, dpr: number): void {
    const th = this.theme
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, this.width, this.height)
    if (!this.current) return
    ctx.textBaseline = 'middle'
    for (const s of this.strips) {
      if (s.kind === 'line') continue
      if (s.unlimited && s.w >= OUTLINE_MIN_W) {
        ctx.strokeStyle = th.ink
        ctx.lineWidth = 1
        ctx.setLineDash([4, 3])
        ctx.strokeRect(s.a + 0.5, s.y - s.w / 2 + 0.5, s.b - s.a - 1, s.w - 1)
        ctx.setLineDash([])
      }
    }
    ctx.font = `${th.fontSizeXs + TEXT_UP}px ${th.fontSans}`
    for (const b of this.busBoxes) {
      if (b.y1 < 0 || b.y0 > this.height) continue
      ctx.fillStyle = th.surfaceRaised
      ctx.fillRect(b.x - BUS_HALF, b.y0, 2 * BUS_HALF, b.y1 - b.y0)
      ctx.strokeStyle = this.classColor(b.cls)
      ctx.lineWidth = 1.5
      ctx.strokeRect(b.x - BUS_HALF + 0.5, b.y0 + 0.5, 2 * BUS_HALF - 1, b.y1 - b.y0 - 1)
      ctx.save()
      ctx.translate(b.x, Math.max(b.y0, 0) + Math.min(b.y1 - Math.max(b.y0, 0), 200) / 2)
      ctx.rotate(-Math.PI / 2)
      ctx.fillStyle = th.inkSecondary
      ctx.textAlign = 'center'
      if (b.y1 - b.y0 > 40) ctx.fillText(b.label, 0, 0)
      ctx.restore()
    }
    for (const b of this.boxes) {
      if (b.y1 < 0 || b.y0 > this.height) continue
      ctx.fillStyle = b.agg ? th.page : th.surfaceRaised
      ctx.fillRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0)
      ctx.strokeStyle = th.axis
      ctx.lineWidth = 1
      ctx.strokeRect(b.x0 + 0.5, b.y0 + 0.5, b.x1 - b.x0 - 1, b.y1 - b.y0 - 1)
      ctx.fillStyle = th.ink
      ctx.font = b.agg ? `600 ${th.fontSizeS + TEXT_UP}px ${th.fontSans}` : `${th.fontSizeXs + TEXT_UP}px ${th.fontSans}`
      ctx.textAlign = 'left'
      clip(ctx, b.label, b.x0 + 6, (b.y0 + b.y1) / 2, b.x1 - b.x0 - (b.agg ? 40 : 10))
    }
    this.stats.texts = 0
    this.stats.shortTexts = 0
    this.stats.noTexts = 0
    if (!this.scaleByBandwidth) {
      const covers = [...this.busBoxes.map((b) => ({ x0: b.x - BUS_HALF, x1: b.x + BUS_HALF, y0: b.y0, y1: b.y1 })), ...this.boxes]
      for (const s of this.strips) {
        if (s.kind !== 'bar' && s.kind !== 'leg') continue
        const r = this.stripText(ctx, s, covers)
        if (r === 'full') this.stats.texts++
        else if (r === 'short') this.stats.shortTexts++
        else this.stats.noTexts++
      }
    }
    const hov = this.strips.filter((s) => s.link.key === this.hoverKey)
    for (const s of hov) {
      ctx.strokeStyle = th.ink
      ctx.lineWidth = 1.5
      ctx.strokeRect(s.a - 1, s.y - Math.max(s.w, 3) / 2 - 1, s.b - s.a + 2, Math.max(s.w, 3) + 2)
    }
  }

  /** "32 % · 164 B/cycle" on a strip, in its longest segment free of the boxes drawn over
   * it; when that does not fit, the short form "32 %"; when neither fits, nothing (the
   * tooltip has the values). Each strip (and loop leg) shows its own direction. */
  private stripText(ctx: CanvasRenderingContext2D, s: Strip, boxes: { x0: number; x1: number; y0: number; y1: number }[]): 'full' | 'short' | null {
    const th = this.theme
    const l = s.link
    const d0 = this.dirLoad(l, 0)
    const d1 = this.dirLoad(l, 1)
    const v = s.dir ? d1 : d0
    const unit = String(this.trace.dims.resources[l.fwd ?? l.members[0] ?? 0]?.unit ?? 'B')
    const pct = `${(100 * v.util).toFixed(v.util >= 0.1 || v.util === 0 ? 0 : 1)} %`
    const full = v.rate > 0 ? `${pct} · ${num(v.rate)} ${unit}/cycle` : pct
    const short = pct
    ctx.font = `600 ${th.fontSizeXs + TEXT_UP}px ${th.fontSans}`
    let segs: [number, number][] = [[s.a, s.b]]
    for (const bx of boxes) {
      if (bx.y0 > s.y || bx.y1 < s.y || bx.x1 <= s.a || bx.x0 >= s.b) continue
      segs = segs.flatMap(([x0, x1]): [number, number][] =>
        bx.x1 <= x0 || bx.x0 >= x1 ? [[x0, x1]] : [[x0, Math.max(x0, bx.x0)], [Math.min(x1, bx.x1), x1]])
        .filter(([x0, x1]) => x1 > x0)
    }
    const best = segs.reduce((m, g) => (g[1] - g[0] > m[1] - m[0] ? g : m), [0, 0] as [number, number])
    const room = best[1] - best[0]
    const kind = ctx.measureText(full).width + 10 <= room ? 'full' : ctx.measureText(short).width + 10 <= room ? 'short' : null
    if (!kind) return null
    ctx.fillStyle = th.inkOnDark
    ctx.textAlign = 'center'
    ctx.fillText(kind === 'full' ? full : short, (best[0] + best[1]) / 2, s.y + 0.5)
    ctx.textAlign = 'left'
    return kind
  }

  /** Whether any strip moves (the animation loop runs only then). */
  get moving(): boolean {
    return this.strips.some((s) => s.kind !== 'line' && s.mode !== 'still' && s.vTop !== 0)
  }

  /** The animation layer at time t (s): the patterns of the strips and loop legs, moved by
   * their speeds. The tiles are opaque, so a frame overwrites the previous one in place;
   * `clear` empties the layer first (after a change of the base layer). */
  drawAnim(ctx: CanvasRenderingContext2D, dpr: number, t: number, clear: boolean): void {
    const t0 = performance.now()
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    if (clear) ctx.clearRect(0, 0, this.width, this.height)
    for (const s of this.strips) {
      if (s.kind === 'line') continue
      const len = s.b - s.a
      if (len <= 0) continue
      const top = s.y - s.w / 2
      if (s.kind === 'leg') {
        // A loop leg: stripes in two halves half a period apart, moving one way.
        this.fillPattern(ctx, s, 'stripe', true, s.a, top, len, s.w / 2, s.vTop * t)
        this.fillPattern(ctx, s, 'stripe', true, s.a, s.y, len, s.w / 2, s.vTop * t, 0.5)
      } else if (s.mode === 'still') this.fillPattern(ctx, s, 'stripe', true, s.a, top, len, s.w, 0)
      else this.fillPattern(ctx, s, 'chevron', s.pointsRight ?? true, s.a, top, len, s.w, s.vTop * t)
    }
    this.stats.animMs.push(performance.now() - t0)
    if (this.stats.animMs.length > 2000) this.stats.animMs.splice(0, 1000)
  }

  private fillPattern(ctx: CanvasRenderingContext2D, s: Strip, kind: 'chevron' | 'stripe', right: boolean,
    x: number, y: number, w: number, h: number, offset: number, phase = 0): void {
    const dpr = this.dpr
    const hd = Math.max(2, Math.round(h * dpr))
    const key = `${kind}|${s.link.cls}|${right ? 1 : 0}|${hd}`
    let p = this.patterns.get(key)
    if (!p) {
      p = this.makePattern(kind, s.link.cls, right, hd)
      this.patterns.set(key, p)
    }
    const period = p.period / dpr
    const ox = x + (((offset + phase * period) % period) + period) % period
    p.pattern.setTransform(new DOMMatrix([1 / dpr, 0, 0, 1 / dpr, ox, y]))
    ctx.fillStyle = p.pattern
    ctx.fillRect(x, y, w, h)
  }

  /** An opaque tile of the base color with a lighter chevron (pointing right or left) or a
   * diagonal stripe, `hd` device pixels high. */
  private makePattern(kind: 'chevron' | 'stripe', cls: LinkClass, right: boolean, hd: number): { pattern: CanvasPattern; period: number } {
    const period = Math.max(4, Math.round(kind === 'chevron' ? hd * 1.1 : hd * 2.2))
    const cv = document.createElement('canvas')
    cv.width = period
    cv.height = hd
    const c = cv.getContext('2d') as CanvasRenderingContext2D
    c.fillStyle = this.classColor(cls)
    c.fillRect(0, 0, period, hd)
    c.fillStyle = this.tint(cls)
    c.beginPath()
    if (kind === 'chevron') {
      // A ">" of arm width about a third of the period, repeated every period.
      const arm = period * 0.36
      const x0 = period * 0.12
      for (const dx of [-period, 0]) {
        c.moveTo(x0 + dx, 0)
        c.lineTo(x0 + arm + dx, 0)
        c.lineTo(x0 + arm + hd / 2 + dx, hd / 2)
        c.lineTo(x0 + arm + dx, hd)
        c.lineTo(x0 + dx, hd)
        c.lineTo(x0 + hd / 2 + dx, hd / 2)
        c.closePath()
      }
      c.fill()
      if (!right) {
        const flipped = document.createElement('canvas')
        flipped.width = period
        flipped.height = hd
        const f = flipped.getContext('2d') as CanvasRenderingContext2D
        f.translate(period, 0)
        f.scale(-1, 1)
        f.drawImage(cv, 0, 0)
        return { pattern: c.createPattern(flipped, 'repeat') as CanvasPattern, period }
      }
    } else {
      // A diagonal stripe half the period wide.
      for (const dx of [-period, 0, period]) {
        c.moveTo(dx, hd)
        c.lineTo(dx + period / 2, hd)
        c.lineTo(dx + period / 2 + hd, 0)
        c.lineTo(dx + hd, 0)
        c.closePath()
      }
      c.fill()
    }
    return { pattern: c.createPattern(cv, 'repeat') as CanvasPattern, period }
  }

  classColor(cls: LinkClass): string {
    return this.theme.lines[CLASS_SLOT[cls]] ?? this.theme.accent
  }

  /** The lighter tint of a class color (the moving pattern). */
  tint(cls: LinkClass): string {
    const c = rgba(this.classColor(cls))
    const mix = (i: number) => Math.round(c[i] + (255 - c[i]) * TINT)
    return `rgb(${mix(0)}, ${mix(1)}, ${mix(2)})`
  }

  /** The link under (x, y), or null. */
  linkAt(x: number, y: number): PLink | null {
    let best: PLink | null = null
    let bestD = 5
    for (const s of this.strips) {
      if (x < s.a - 8 || x > s.b + (s.kind === 'leg' ? s.w + 20 : 2)) continue
      const dist = Math.max(0, Math.abs(y - s.y) - s.w / 2)
      if (dist < bestD) { best = s.link; bestD = dist }
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

/** The droplet flare of a strip w high: how far it widens at an end. */
function flare(w: number): number {
  return Math.max(2, Math.min(10, w * 0.45))
}

/** The path of a strip body from a to b at y, w high, with a concave flare (a droplet
 * meeting a surface) at the ends asked for. */
function stripBody(ctx: CanvasRenderingContext2D, a: number, b: number, y: number, w: number, f: number,
  atA: boolean, atB: boolean): void {
  const h = w / 2
  ctx.beginPath()
  if (atA) {
    ctx.moveTo(a, y - h - f)
    ctx.quadraticCurveTo(a, y - h, a + f, y - h)
  } else ctx.moveTo(a, y - h)
  if (atB) {
    ctx.lineTo(b - f, y - h)
    ctx.quadraticCurveTo(b, y - h, b, y - h - f)
    ctx.lineTo(b, y + h + f)
    ctx.quadraticCurveTo(b, y + h, b - f, y + h)
  } else {
    ctx.lineTo(b, y - h)
    ctx.lineTo(b, y + h)
  }
  if (atA) {
    ctx.lineTo(a + f, y + h)
    ctx.quadraticCurveTo(a, y + h, a, y + h + f)
  } else ctx.lineTo(a, y + h)
  ctx.closePath()
}

/** The center line of a hairpin: out at yt to xe, a semicircle, back at yb. */
function hairpinPath(ctx: CanvasRenderingContext2D, xa: number, xe: number, yt: number, yb: number): void {
  ctx.beginPath()
  ctx.moveTo(xa, yt)
  ctx.lineTo(xe, yt)
  ctx.arc(xe, (yt + yb) / 2, (yb - yt) / 2, -Math.PI / 2, Math.PI / 2)
  ctx.lineTo(xa, yb)
}

function num(v: number): string {
  return v.toFixed(v >= 100 || Number.isInteger(v) ? 0 : v >= 10 ? 1 : 2)
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
