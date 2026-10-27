// Traffic view renderer (views-design Sections 3 and 6.2): hierarchy columns, buses as
// vertical boxes, one strip per link in its class color, as wide as its bandwidth, with a
// pattern that moves at its utilization (chevrons on a one-way link, two stripe halves on a
// duplex link), levels of detail on y.
import type { ChargeCache } from '../data/charges'
import type { Trace } from '../data/trace'
import type { Theme } from '../theme/theme'
import { isDict } from '../data/columns'
import { num, pct, rate, relative, short, splitPath } from '../ui/format'
import { tipList, type TipContent, type TipRow } from '../ui/Tooltip'
import { recorded, type Recorded } from '../timeline/rows'
import { rgba } from '../timeline/raster'
import { chargesAmount, rangeAmount } from '../timeline/util'
import { columns, layout, LOOP_LEG, type BandKind, type Layout, type PBand, type PLink, type PStrip } from './layout'
import { MergeTree, type MGroup } from './merge'
import { pack } from './pack'
import { type LinkClass } from './model'
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
const MAX_ZOOM_X = 16               // the largest horizontal zoom
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
  /** the direction its text shows (uni strips and loop legs), and its channel (all: the
   * busier of read and write) */
  dir: 0 | 1
  ch?: PStrip['ch']
}

/** A block's or aggregated row's box, and a bus box, in px. */
interface Box {
  x0: number
  x1: number
  y0: number
  y1: number
  label: string
  agg: boolean
  /** a closed group or node: the key that a click opens */
  open?: string
}

export interface BusBox {
  x: number
  /** the bus path and its attachments */
  path: string
  atts: number[]
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
  /** the zoom: the height (px) the drawing takes; the scroll offset in px */
  zoomH = 400
  scroll = 0
  /** the horizontal zoom (1: the plot fits the width; text keeps its size) and the share
   * of the zoomed plot left of the view (a share: it holds across a resize) */
  zoomX = 1
  xStart = 0
  /** the plot's left edge (after the name gutter) and its width at zoom 1 (px) */
  plotLeft = 0
  plotW = 1
  range = { a: 0, b: 1 }
  /** per class: visible (the layout leaves hidden classes out), and collapse when no
   * traffic (a link with no traffic in the range is a thin line) */
  classes: Record<LinkClass, ClassOptions> = {
    global: { visible: true, collapse: true }, local: { visible: true, collapse: true }, control: { visible: true, collapse: true },
  }
  hoverKey: string | null = null
  /** square-root strip widths by bandwidth (no text), else fixed heights with text */
  scaleByBandwidth = false
  /** read and write channels: one strip per direction (the busier channel) or one per
   * channel and direction */
  channels: 'combined' | 'separate' = 'combined'
  readonly stats = { drawMs: [] as number[], animMs: [] as number[], texts: 0, shortTexts: 0, noTexts: 0 }
  private strips: Strip[] = []
  private boxes: Box[] = []
  private busBoxes: BusBox[] = []
  /** bus port resource -> bus id */
  private readonly busOfPort = new Map<number, number>()
  private readonly patterns = new Map<string, { pattern: CanvasPattern; period: number }>()
  private dpr = 1
  private readonly layouts = new Map<string, Layout>()
  private labelW: { key: string; w: number } | null = null
  /** the merge tree, and the user's splits (true) and merges (false) until Fit */
  readonly tree: MergeTree
  readonly overrides = new Map<string, boolean>()
  private picked: { key: string; lay: Layout; cut: Set<string> } | null = null
  private stops: { key: string; zooms: number[] } | null = null
  /** the zoom levels (levelCuts), made once */
  private levels: Set<string>[] | null = null
  /** after a click: the cut to draw as it is (the previous cut with the split or merge) */
  private pending: Set<string> | null = null
  private allOpen: Set<string> | null = null
  /** gutter names and block-group brackets: a click merges the group back (a closed
   * group's name: splits it) */
  private bandHits: { x0: number; x1: number; y0: number; y1: number; key: string; split?: boolean }[] = []
  /** The gutter labels of the last base draw: per open node and closed group of nodes,
   * its span (the rows of its boxes and strips) and where its name is drawn. */
  gutter: GutterLabel[] = []
  /** the widest strip's bandwidth of the last base draw (strip widths) */
  private bwRef = 1
  private readonly bidir: Map<number, boolean>  // resource -> carried traffic over the run
  private current: { lay: Layout } | null = null
  private loads = new Map<string, LinkLoad>()
  private loadsKey = ''

  constructor(trace: Trace, charges: ChargeCache, theme: Theme) {
    this.trace = trace
    this.charges = charges
    this.themeValue = theme
    this.model = new TrafficModel(trace)
    this.tree = new MergeTree(this.model)
    this.rec = recorded(trace)
    this.bidir = new Map(trace.dims.resources.map((r) => [r.id as number, (r.amount as number) > 0]))
    for (const at of trace.dims.attachments) {
      for (const f of ['in_resource', 'out_resource', 'in_wr_resource', 'out_wr_resource']) {
        const r = at[f] as number | null
        if (r !== null && r !== undefined && r >= 0) this.busOfPort.set(r, at.bus as number)
      }
    }
  }

  private get visibleClasses(): Record<LinkClass, boolean> {
    return { global: this.classes.global.visible, local: this.classes.local.visible, control: this.classes.control.visible }
  }

  /** The layout of a cut (its open nodes and groups), packed for the strip pitch. */
  private lay(open: Set<string>): Layout {
    const v = this.visibleClasses
    const key = `${+v.global}${+v.local}${+v.control}|${this.pitch}|${this.channels}|${[...open].sort().join(',')}`
    let l = this.layouts.get(key)
    if (!l) {
      l = layout(this.model, this.tree, (k) => open.has(k), v, this.channels === 'separate')
      pack(l, { pitch: this.pitch, strip: this.stripMax, gap: SLOT_GAP, boxGap: BOX_GAP,
        boxHeight: (slots) => this.boxHeight(slots) })
      if (this.layouts.size > 32) this.layouts.delete(this.layouts.keys().next().value as string)
      this.layouts.set(key, l)
    }
    return l
  }

  /** Every node and every group of two or more: the full cut. */
  private get fullCut(): Set<string> {
    if (!this.allOpen) {
      const out = new Set<string>()
      const visit = (g: MGroup) => {
        if (g.members.length > 1 || 'node' in g.members[0]) out.add(g.key)
        for (const p of g.parts) visit(p)
        for (const x of g.members.length === 1 && 'node' in g.members[0] ? this.tree.runs[g.members[0].node] : []) visit(x)
      }
      out.add(`n${this.model.root}`)
      for (const g of this.tree.runs[this.model.root]) visit(g)
      this.allOpen = out
    }
    return this.allOpen
  }

  /** The zoom levels, coarsest first: each a cut that treats every parent at a depth the
   * same. A level has, per depth, the number of merge-tree splits of every run of children
   * of the nodes at that depth (0: a run is one box), and the depth down to which nodes are
   * open. The order: at each depth the runs of child nodes split step by step until their
   * nodes are single, then those nodes open (one depth down); then the runs of blocks split
   * further, the shallow depths first. Siblings with different counts take the same steps. */
  levelCuts(): Set<string>[] {
    if (this.levels) return this.levels
    const m = this.model
    const tree = this.tree
    const steps = (g: MGroup): number => (g.parts.length ? 1 + Math.max(...g.parts.map(steps)) : 0)
    const isNodes = (g: MGroup) => 'node' in g.members[0]
    const nodeK = Array.from({ length: m.depth + 1 }, () => 0)
    const blockK = Array.from({ length: m.depth + 1 }, () => 0)
    for (const n of m.nodes) {
      for (const g of tree.runs[n.id]) {
        const k = steps(g)
        if (isNodes(g)) nodeK[n.depth] = Math.max(nodeK[n.depth], k)
        else blockK[n.depth] = Math.max(blockK[n.depth], k)
      }
    }
    const cut = (k: number[], openDepth: number): Set<string> => {
      const open = new Set([`n${m.root}`])
      const visit = (id: number) => { for (const g of tree.runs[id]) split(g, k[m.nodes[id].depth]) }
      const split = (g: MGroup, left: number) => {
        if (g.parts.length) {
          if (left <= 0) return
          open.add(g.key)
          for (const q of g.parts) split(q, left - 1)
        } else if (isNodes(g)) {
          const c = (g.members[0] as { node: number }).node
          if (m.nodes[c].depth <= openDepth) { open.add(g.key); visit(c) }
        }
      }
      visit(m.root)
      return open
    }
    const out: Set<string>[] = []
    const push = (c: Set<string>) => {
      const last = out[out.length - 1]
      if (!last || last.size !== c.size || [...c].some((x) => !last.has(x))) out.push(c)
    }
    const k = Array.from({ length: m.depth + 1 }, () => 0)
    for (let d = 0; d <= m.depth; d++) {
      for (let s = 0; s <= nodeK[d]; s++) { k[d] = s; push(cut(k, d)) }
    }
    for (let d = 0; d <= m.depth; d++) {
      for (let s = k[d] + 1; s <= Math.max(nodeK[d], blockK[d]); s++) { k[d] = s; push(cut(k, m.depth)) }
    }
    this.levels = out
    return out
  }

  /** A level's cut with the user's splits (the group and the groups and nodes around it
   * open) and merges (the group closed, with everything inside it). */
  private withOverrides(cut: Set<string>): Set<string> {
    if (!this.overrides.size) return cut
    const out = new Set(cut)
    const inside = (k: string, of: string): boolean => {
      for (let x: string | undefined = k; x; x = this.tree.parentOf.get(x)) if (x === of) return true
      return false
    }
    for (const [key, on] of this.overrides) {
      if (on) for (let x: string | undefined = key; x; x = this.tree.parentOf.get(x)) out.add(x)
      else for (const x of [...out]) if (inside(x, key)) out.delete(x)
    }
    return out
  }

  /** The layout for the zoom: the cut whose packed drawing fits in the zoom height (the
   * full cut from the full layout's height). It is drawn at its packed size (a spread would
   * move a box's strips against the strips packed next to them). */
  pick(): Layout {
    const v = this.visibleClasses
    const key = `${this.zoomH}|${+v.global}${+v.local}${+v.control}|${this.pitch}|${this.channels}|${[...this.overrides].join(',')}`
    if (this.picked?.key === key) return this.picked.lay
    if (this.pending) {
      const cut = this.pending
      this.pending = null
      const lay = this.lay(cut)
      this.picked = { key, lay, cut }
      return lay
    }
    // The finest level whose packed drawing fits in the zoom height.
    const levels = this.levelCuts()
    let cut = this.withOverrides(levels[0])
    for (let i = levels.length - 1; i > 0; i--) {
      const c = this.withOverrides(levels[i])
      if (this.lay(c).height <= this.zoomH) { cut = c; break }
    }
    const lay = this.lay(cut)
    this.picked = { key, lay, cut }
    return lay
  }

  /** The zoom of each level from the coarsest to the full one, for the zoom slider: the
   * height of its packed drawing (the zoom from which it is picked; a level that packs no
   * taller than the next is left out, the user's splits and merges apply). Cached per state. */
  zoomStops(): number[] {
    const v = this.visibleClasses
    const key = `${+v.global}${+v.local}${+v.control}|${this.pitch}|${this.channels}|${[...this.overrides].join(',')}`
    if (this.stops?.key === key) return this.stops.zooms
    const keep = { zoomH: this.zoomH, picked: this.picked, pending: this.pending }
    this.pending = null
    const zooms: number[] = []
    let last: Layout | null = null
    for (const c of this.levelCuts()) {
      this.zoomH = Math.max(40, this.lay(this.withOverrides(c)).height)
      const lay = this.pick()
      if (lay !== last && (!zooms.length || this.zoomH > zooms[zooms.length - 1])) zooms.push(this.zoomH)
      last = lay
    }
    this.zoomH = keep.zoomH
    this.picked = keep.picked
    this.pending = keep.pending
    this.stops = { key, zooms }
    return zooms
  }

  /** The slider position of the zoom: the last cut whose stop it has reached. */
  zoomStop(zooms: number[]): number {
    let i = 0
    while (i + 1 < zooms.length && zooms[i + 1] <= this.zoomH * (1 + 1e-9)) i++
    return i
  }

  /** Sets the zoom to a stop of the slider (the scroll keeps the same share of the drawing). */
  zoomTo(z: number): void {
    const before = this.scroll / Math.max(1, this.pick().height)
    this.zoomH = z
    this.scroll = before * this.pick().height
    this.clampScroll()
  }

  /** The height (px) of the packed full layout: the zoom from which it is drawn. */
  get fullHeight(): number {
    return this.lay(this.fullCut).height
  }

  /** A click: on a closed group's box (or a closed node's) splits it one step; on an open
   * group's or node's name in the gutter, or on a split block group's bracket, merges it
   * back. True if it changed the cut. */
  clickAt(x: number, y: number): boolean {
    const hit = (r: { x0: number; x1: number; y0: number; y1: number }) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1
    // The rest of the cut stays as it is (drawn once as it is; the zoom follows the change).
    const now = new Set(this.picked?.cut ?? [])
    const band = this.bandHits.find(hit)
    if (band?.split) {
      this.overrides.set(band.key, true)
      for (let k: string | undefined = band.key; k; k = this.tree.parentOf.get(k)) now.add(k)
      this.pending = now
      this.zoomH = Math.max(this.zoomH, this.lay(now).height)
      return true
    }
    if (band) {
      this.overrides.set(band.key, false)
      const inside = (k: string): boolean => k === band.key || (this.tree.parentOf.has(k) && inside(this.tree.parentOf.get(k) as string))
      this.pending = new Set([...now].filter((k) => !inside(k)))
      this.zoomH = Math.min(this.zoomH, this.lay(this.pending).height)
      return true
    }
    const box = this.boxes.find((b) => b.open && hit(b))
    if (box?.open) {
      this.overrides.set(box.open, true)
      for (let k: string | undefined = box.open; k; k = this.tree.parentOf.get(k)) now.add(k)
      this.pending = now
      this.zoomH = Math.max(this.zoomH, this.lay(now).height)
      return true
    }
    return false
  }

  /** Whether (x, y) is on something a click changes. */
  clickable(x: number, y: number): boolean {
    const hit = (r: { x0: number; x1: number; y0: number; y1: number }) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1
    return this.bandHits.some(hit) || this.boxes.some((b) => b.open && hit(b))
  }

  resize(w: number, h: number): void {
    const first = this.width <= 1
    this.width = w
    this.height = h
    if (first) this.fit()
  }

  /** Fit: the cut for the view's height, the user's splits and merges dropped. */
  fit(): void {
    this.zoomH = Math.max(40, this.height - 20)
    this.overrides.clear()
    this.scroll = 0
  }

  zoomAt(y: number, factor: number): void {
    // The zoom picks the level; the point under y stays at the same share of the drawing.
    const before = (y + this.scroll) / Math.max(1, this.pick().height)
    this.zoomH = Math.max(40, Math.min(Math.max(this.fullHeight, this.height), this.zoomH * factor))
    this.scroll = before * this.pick().height - y
    this.clampScroll()
  }

  scrollBy(dy: number): void {
    this.scroll += dy
    this.clampScroll()
  }

  // ---- the horizontal zoom ----------------------------------------------------------------

  /** The plot's horizontal scroll (px). */
  get scrollX(): number {
    return this.xStart * this.plotW * this.zoomX
  }

  /** Zooms horizontally around x (px); the point under it stays. */
  zoomXAt(x: number, factor: number): void {
    const at = Math.max(0, Math.min(this.plotW, x - this.plotLeft)) / this.plotW  // share of the view
    const p = this.xStart + at / this.zoomX                                          // share of the plot
    this.zoomX = Math.max(1, Math.min(MAX_ZOOM_X, this.zoomX * factor))
    this.xStart = p - at / this.zoomX
    this.clampX()
  }

  scrollXBy(dx: number): void {
    this.xStart += dx / (this.plotW * this.zoomX)
    this.clampX()
  }

  /** The visible part of the plot as shares of its zoomed width (the scroll bar's thumb). */
  get xView(): { start: number; end: number } {
    return { start: this.xStart, end: this.xStart + 1 / this.zoomX }
  }

  /** Shows the shares [start, end) of the plot (a thumb drag; [0, 1): fit). */
  setXView(start: number, end: number): void {
    const span = Math.max(1 / MAX_ZOOM_X, Math.min(1, end - start))
    this.zoomX = 1 / span
    this.xStart = start
    this.clampX()
  }

  private clampX(): void {
    this.xStart = Math.max(0, Math.min(1 - 1 / this.zoomX, this.xStart))
  }

  /** Clips a layer to the plot (left of it, the name gutter). */
  private clipPlot(ctx: CanvasRenderingContext2D): void {
    ctx.save()
    ctx.beginPath()
    ctx.rect(this.plotLeft - 6, 0, this.width - this.plotLeft + 6, this.height)
    ctx.clip()
  }

  private clampScroll(): void {
    const total = this.pick().height + 20
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
        if (!g) { this.charges.prefetch(blk); return null }
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
      const g = this.groupLoad(l.members)
      v = { util: g.util, rate: g.rate, exact: g.exact, charged: g.charged }
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
    // An approximate load (its charges still loading) is computed again on the next draw.
    if (v.exact) this.loads.set(l.key, v)
    return v
  }

  /** The load of a group of resources: per kind (role, and read or write channel) the
   * summed rate over the summed ceiling; the busiest kind sets the utilization (the max
   * rule of fabric nodes, so that a read channel and its write channel, or a port and the
   * memory port behind it, are not added together). */
  private groupLoad(rs: number[]): { util: number; rate: number; write: boolean; exact: boolean; charged: boolean;
    kinds: { key: string; rate: number; cap: number; n: number; unit: string }[] } {
    const res = this.trace.dims.resources
    const kinds = new Map<string, { key: string; rate: number; cap: number; n: number; unit: string }>()
    let exact = true
    let charged = false
    for (const r of rs) {
      const key = `${String(res[r].role)}${res[r].write ? ' write' : ''}`
      const k = kinds.get(key) ?? { key, rate: 0, cap: 0, n: 0, unit: String(res[r].unit ?? '') }
      const x = this.rate(r)
      k.rate += x.value
      k.cap += (res[r].ceiling as number | null) ?? 0
      k.n++
      exact &&= x.exact
      charged ||= x.value > 0
      kinds.set(key, k)
    }
    let best = { util: 0, rate: 0, write: false }
    for (const k of kinds.values()) {
      const u = k.cap > 0 ? k.rate / k.cap : 0
      if (u > best.util || (best.util === 0 && k.rate > best.rate)) best = { util: u, rate: k.rate, write: k.key.endsWith(' write') }
    }
    return { ...best, exact, charged, kinds: [...kinds.values()] }
  }

  /** The tooltip of a link, attachment or link group: per direction the load of each of its
   * resources (a group: of each kind of resource, summed) in a table, then the task kinds. */
  linkTip(l: PLink): TipContent {
    const node = String(this.trace.dims.nodes[l.node]?.path ?? '')
    const tip: TipContent = { title: relative(l.name, node), path: short(node), sections: [] }
    if (this.notRecorded(l)) {
      tip.sections.push({ kind: 'note', text: 'not recorded' })
      return tip
    }
    const res = this.trace.dims.resources
    const heads = this.headsOf(l)
    // Per row (a resource, or a kind of resource): its cells per direction, and whether it
    // carried anything (an idle write channel adds nothing: the strips show the write load).
    const rows = new Map<string, { cells: string[]; busy: boolean; write: boolean }>()
    const put = (key: string, k: 0 | 1, v: number, cap: number, exact: boolean, write: boolean) => {
      const row = rows.get(key) ?? { cells: [key, '', '', '', ''], busy: false, write }
      row.cells[1 + 2 * k] = `${exact ? '' : '≈'}${cap > 0 ? `${num(v)} / ${num(cap)}` : num(v)}`
      row.cells[2 + 2 * k] = cap > 0 ? pct(v / cap) : ''
      row.busy ||= v > 0
      rows.set(key, row)
    }
    let unit = ''
    if (l.kind === 'cross' || l.kind === 'self') {
      for (const k of [0, 1] as const) {
        const g = this.groupLoad(k === 0 ? l.fwdMembers : l.revMembers)
        for (const x of g.kinds) {
          unit ||= x.unit
          put(x.n > 1 ? `${x.key} ×${x.n}` : x.key, k, x.rate, x.cap, g.exact, x.key.endsWith(' write'))
        }
      }
    } else {
      for (const k of [0, 1] as const) {
        for (const r of directionSet(l, k)) {
          unit ||= String(res[r].unit ?? '')
          const x = this.rate(r)
          put(this.resourceRole(l, r), k, x.value, (res[r].ceiling as number | null) ?? 0, x.exact, !!res[r].write)
        }
      }
    }
    const shown = [...rows.values()].filter((r) => r.busy || !r.write).map((r) => r.cells)
    if (shown.length) tip.sections.push({ kind: 'table', head: [`${unit}/cycle`, heads[0], '', heads[1], ''], rows: shown })
    const top = this.topKinds(l)
    if (top === 'loading') tip.sections.push({ kind: 'note', text: 'task kinds …' })
    else if (top !== 'too long' && top.length) {
      tip.sections.push(tipList('task kinds', top.map((k) => ({ share: k.share, name: k.name, value: pct(k.share) })), top.length))
    }
    return tip
  }

  /** A resource's row in a link tooltip: the link, the port of its bus (by the bus name), or
   * its role; ' write' for a write channel. */
  private resourceRole(l: PLink, r: number): string {
    const res = this.trace.dims.resources[r]
    const write = res.write ? ' write' : ''
    if (r === l.fwd || r === l.rev) return `${l.kind === 'att' ? 'port' : 'link'}${write}`
    const bus = this.busOfPort.get(r)
    if (bus !== undefined) return `${splitPath(String(this.trace.dims.buses[bus]?.path ?? '')).name} port${write}`
    return `${String(res.role ?? '')}${write}`
  }

  /** The bus box under (x, y), or null. */
  busAt(x: number, y: number): BusBox | null {
    for (const b of this.busBoxes) if (Math.abs(x - b.x) <= BUS_HALF + 2 && y >= b.y0 && y <= b.y1) return b
    return null
  }

  /** The tooltip of a bus box: its busiest port over the range and that port's load. */
  busTip(b: BusBox): TipContent {
    const res = this.trace.dims.resources
    const atts = this.trace.dims.attachments
    let best = -1
    let bestU = -1
    let exact = true
    let v = 0
    for (const a of b.atts) {
      for (const f of ['in_resource', 'out_resource', 'in_wr_resource', 'out_wr_resource']) {
        const r = atts[a]?.[f] as number | null | undefined
        if (r === null || r === undefined || r < 0) continue
        const cap = (res[r].ceiling as number | null) ?? 0
        const x = this.rate(r)
        exact &&= x.exact
        const u = cap > 0 ? x.value / cap : 0
        if (u > bestU) { bestU = u; best = r; v = x.value }
      }
    }
    const { name, parent } = splitPath(b.path)
    const rows: TipRow[] = []
    if (best >= 0) {
      const cap = (res[best].ceiling as number | null) ?? null
      rows.push({ label: 'busiest', value: relative(String(res[best].name), b.path), extra: `${exact ? '' : '≈'}${pct(bestU)}` })
      rows.push({ label: 'load', value: `${exact ? '' : '≈'}${rate(v, cap, String(res[best].unit ?? ''))}` })
    }
    rows.push({ label: 'ports', value: String(b.atts.length) })
    return { title: name, path: parent, sections: [{ kind: 'rows', rows }] }
  }

  /** The names of a link's two directions in its tooltip. */
  private headsOf(l: PLink): [string, string] {
    if (l.kind === 'att') return ['in', 'out']
    if (l.kind === 'link') {
      const d = this.trace.dims
      const [a, b] = l.ends.map((e) => d.buses[d.attachments[e].bus as number].node)
      if (a === b) return ['ab', 'ba']
    }
    return ['up', 'down']
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
    // A group counts as recorded if one of its nodes or a node below them is.
    const groupRecorded = () => l.group.some((n) => this.rec.inTree[n] || this.anyRecordedBelow(n))
    if (l.group.length ? !groupRecorded() : !this.rec.inTree[l.node]) return true
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
      else this.charges.prefetch(blk)
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
      if (row < 0) return 'not in the trace'
      const kind = this.trace.facts.tasks.cols.kind
      if (kind && isDict(kind) && kind.codes[row] >= 0) return kind.dict[kind.codes[row]]
      const op = (this.trace.facts.tasks.cols.opcode as Int32Array)[row]
      return String(this.trace.dims.opcodes[op]?.name ?? `opcode ${op}`)
    }
    if (msg >= 0) return `message ${String(this.trace.dims.message_kinds[msg]?.name ?? msg)}`
    return 'no task'
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
  dirLoad(l: PLink, k: 0 | 1, ch: PStrip['ch'] = 'all'): { util: number; rate: number; write: boolean } {
    const res = this.trace.dims.resources
    const ceil = (r: number) => (res[r].ceiling as number | null) ?? 0
    const keep = (r: number) => ch === 'all' || !!res[r].write === (ch === 'write')
    if (l.kind === 'cross' || l.kind === 'self') {
      const g = this.groupLoad((k === 0 ? l.fwdMembers : l.revMembers).filter(keep))
      return { util: g.util, rate: g.rate, write: g.write }
    }
    // The busiest of the direction's resources (a write channel included), by % of
    // ceiling, then by rate.
    let best = { util: 0, rate: 0, write: false }
    for (const r of directionSet(l, k).filter(keep)) {
      const v = this.rate(r).value
      const u = ceil(r) > 0 ? v / ceil(r) : 0
      if (u > best.util || (u === best.util && v > best.rate)) best = { util: u, rate: v, write: !!res[r].write }
    }
    return best
  }

  private geometry(): { lay: Layout; X: (x: number) => number; Y: (y: number) => number; labelW: number } {
    const lay = this.pick()
    this.current = { lay }
    // Columns of unequal width: the bus columns wider (their strips carry text), the block
    // columns narrower.
    const { busCol } = columns(this.model.depth)
    const isBus = new Set(Array.from({ length: this.model.depth + 1 }, (_, d) => busCol(d)))
    const weight = Array.from({ length: lay.cols }, (_, i) => (isBus.has(i) ? BUS_COL_WEIGHT : BLOCK_COL_WEIGHT))
    const labelW = this.labelWidth()
    this.plotLeft = 8 + labelW
    this.plotW = Math.max(1, this.width - labelW - 16)
    this.clampX()
    // The horizontal zoom scales the columns; the text keeps its size.
    const unit = this.plotW * this.zoomX / weight.reduce((p, q) => p + q, 0)
    const start = [0]
    for (const w of weight) start.push(start[start.length - 1] + w * unit)
    const X = (x: number) => {
      const i = Math.max(0, Math.min(lay.cols - 1, Math.floor(x)))
      return this.plotLeft + start[i] + (x - i) * weight[i] * unit - this.scrollX
    }
    return { lay, X, Y: (y: number) => 10 + y - this.scroll, labelW }
  }

  /** The gutter: one column, the names of the open nodes and of the closed groups of
   * nodes indented by depth, as wide as the widest indented name of any level (the same at
   * every level, so the plot does not move with the zoom). */
  private labelWidth(): number {
    const font = `${this.theme.fontSizeXs + TEXT_UP}px ${this.theme.fontSans}`
    if (this.labelW?.key !== font) {
      const ctx = document.createElement('canvas').getContext('2d') as CanvasRenderingContext2D
      ctx.font = font
      let w = 0
      const visit = (g: MGroup, depth: number) => {
        if ('node' in g.members[0]) w = Math.max(w, indent(depth) + ctx.measureText(g.label).width)
        for (const p of g.parts) visit(p, depth)
      }
      for (const n of this.model.nodes) for (const g of this.tree.runs[n.id]) visit(g, n.depth + 1)
      this.labelW = { key: font, w: w + 10 }
    }
    return Math.max(LABEL_MIN, Math.min(this.width * LABEL_MAX, this.labelW.w))
  }

  /** A strip's width (px): fixed, or the square root of its bandwidth (the widest link of
   * the drawn level at SCALED_MAX). */
  private stripWidth(bw: number): number {
    return this.scaleByBandwidth ? Math.max(3, SCALED_MAX * Math.sqrt(bw / this.bwRef)) : STRIP_H
  }

  /** The rows (px) of a unit: its box, and the strips of its links. */
  private unitRows(u: PBand['units'][number], Y: (y: number) => number): [number, number] {
    let y0 = Infinity
    let y1 = -Infinity
    if (u.box) [y0, y1] = this.boxSpan(Y, u.box.yc, u.box.slots)
    for (const l of u.links) {
      const rows = l.kind === 'self'
        ? [[l.slot, Math.max(this.bandwidth(l, 0).bw, this.bandwidth(l, 1).bw)], [l.slot + LOOP_LEG, Math.max(this.bandwidth(l, 0).bw, this.bandwidth(l, 1).bw)]]
        : l.strips.map((st, i) => [l.slot + i, this.bandwidth(l, st.dir ?? 0).bw])
      for (const [slot, bw] of rows) {
        const y = this.slotY(Y, l.yc, slot, l.slots)
        const h = this.stripWidth(bw) / 2
        y0 = Math.min(y0, y - h)
        y1 = Math.max(y1, y + h)
      }
    }
    return [y0, y1]
  }

  /** The gutter (left of the plot, fixed with the horizontal zoom): per open node and per
   * closed group of nodes, a bracket over the rows of its boxes and strips and its name at
   * the top of them (kept in view while the span is). Names never overlap: one pushed down
   * within its span, else drawn at its top with the name it meets shortened. */
  private drawGutter(ctx: CanvasRenderingContext2D, lay: Layout, Y: (y: number) => number, labelW: number): void {
    const th = this.theme
    ctx.font = `${th.fontSizeXs + TEXT_UP}px ${th.fontSans}`
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'left'
    const LINE = th.fontSizeXs + TEXT_UP + 4
    const out: GutterLabel[] = []
    for (const b of lay.bands) {
      if (b.kind === 'group' || b.nest < 1) continue
      let y0 = Infinity
      let y1 = -Infinity
      for (const u of b.units) {
        const [a, c] = this.unitRows(u, Y)
        y0 = Math.min(y0, a)
        y1 = Math.max(y1, c)
      }
      if (!(y1 > y0)) continue
      const x = indent(b.nest)
      const full = ctx.measureText(b.label).width
      out.push({ key: b.key, kind: b.kind as Exclude<BandKind, 'group'>, label: b.label, nest: b.nest, y0, y1, x,
        yt: NaN, w: Math.min(full, labelW - x - 4), full })
    }
    out.sort((p, q) => p.y0 - q.y0 || p.nest - q.nest)
    const placed: GutterLabel[] = []
    const meets = (p: GutterLabel, q: GutterLabel, yt: number) => Math.abs(q.yt - yt) < LINE && p.x < q.x + q.w && q.x < p.x + p.w
    for (const g of out) {
      if (g.y1 < 0 || g.y0 > this.height) continue
      const top = Math.max(g.y0, 0) + LINE / 2
      let yt = Math.min(top, g.y1 - LINE / 2)
      for (let q = placed.find((p) => meets(g, p, yt)); q; q = placed.find((p) => meets(g, p, yt))) yt = q.yt + LINE
      if (yt + LINE / 2 > g.y1 + 1) {
        // no room below: at the top, and the names it meets end before it
        yt = Math.max(g.y0 + LINE / 2, Math.min(top, g.y1 - LINE / 2))
        for (const p of placed) if (Math.abs(p.yt - yt) < LINE && p.x < g.x) p.w = Math.min(p.w, g.x - p.x - 4)
      }
      g.yt = yt
      placed.push(g)
    }
    this.gutter = out
    for (const g of placed) {
      ctx.fillStyle = th.axis
      ctx.fillRect(g.x - 4, g.y0, 1, Math.max(1, g.y1 - g.y0))
      ctx.fillStyle = g.kind === 'node' ? th.inkSecondary : th.inkMuted
      clip(ctx, g.label, g.x, g.yt, g.w)
      this.bandHits.push({ x0: g.x - 4, x1: g.x + g.w, y0: g.yt - LINE / 2, y1: g.yt + LINE / 2,
        key: g.kind === 'agg' ? g.key.slice(1) : g.key, split: g.kind === 'agg' })
    }
  }

  /** The gutter label under (x, y), or null. */
  gutterAt(x: number, y: number): GutterLabel | null {
    if (x >= this.plotLeft - 6) return null
    const LINE = this.theme.fontSizeXs + TEXT_UP + 4
    return this.gutter.find((g) => g.yt === g.yt && Math.abs(y - g.yt) < LINE / 2 && x >= g.x - 4 && x <= g.x + g.w) ?? null
  }

  /** The y (px) of a slot of a box centered at row yc with `slots` slots. */
  private slotY(Y: (y: number) => number, yc: number, slot: number, slots: number): number {
    return Y(yc) + (slot - (slots - 1) / 2) * this.pitch
  }

  /** A box (block or aggregated row) around its center: sized to its strips. */
  private boxSpan(Y: (y: number) => number, yc: number, slots: number): [number, number] {
    const h = this.boxHeight(slots)
    return [Y(yc) - h / 2, Y(yc) + h / 2]
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
    const { lay, X, Y, labelW } = this.geometry()
    ctx.textBaseline = 'middle'
    // A rule under each innermost open node (the names: drawGutter, after the plot).
    this.bandHits = []
    const nodeBands = lay.bands.filter((b) => b.kind === 'node' && b.nest >= 1)
    for (const b of nodeBands) {
      const y1 = Y(b.y1)
      if (y1 < 0 || Y(b.y0) > this.height) continue
      if (nodeBands.some((c) => c.nest > b.nest && c.y0 >= b.y0 && c.y1 <= b.y1)) continue
      ctx.fillStyle = th.grid
      ctx.fillRect(indent(b.nest) - 4, y1 - 0.5, this.width, 1)
    }
    this.clipPlot(ctx)
    // Boxes of the blocks and aggregated rows, sized to their strips (drawn on the top
    // layer; kept here for the hairpins, the texts and the hit tests).
    this.boxes = []
    for (const b of lay.blocks) {
      const [y0, y1] = this.boxSpan(Y, b.yc, b.slots)
      this.boxes.push({ x0: X(b.x0), x1: X(b.x1), y0, y1, label: b.label, agg: false, open: b.open })
    }
    // Split block groups: a thin bracket beside their members (outer groups farther out).
    for (const k of lay.brackets) {
      const ys = k.blocks.map((b) => this.boxSpan(Y, b.yc, b.slots))
      const y0 = Math.min(...ys.map((y) => y[0])) + 2
      const y1 = Math.max(...ys.map((y) => y[1])) - 2
      if (y1 < 0 || y0 > this.height) continue
      const off = 4 + 4 * k.level
      const x = k.left ? X(Math.min(...k.blocks.map((b) => b.x0))) - off : X(Math.max(...k.blocks.map((b) => b.x1))) + off
      const tick = k.left ? 3 : -3
      ctx.strokeStyle = th.inkMuted
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(x + tick, y0 + 0.5)
      ctx.lineTo(x + 0.5, y0 + 0.5)
      ctx.lineTo(x + 0.5, y1 - 0.5)
      ctx.lineTo(x + tick, y1 - 0.5)
      ctx.stroke()
      this.bandHits.push({ x0: x - 3, x1: x + 3, y0, y1, key: k.key })
    }
    for (const g of lay.aggs) {
      const [y0, y1] = this.boxSpan(Y, g.yc, g.slots)
      this.boxes.push({ x0: X(g.x0), x1: X(g.x1), y0, y1, label: g.label, agg: true, open: g.open })
    }
    // Strip widths: fixed, or the square root of the bandwidth (the widest link of the
    // drawn level at SCALED_MAX).
    this.bwRef = Math.max(1e-9, ...lay.links.map((l) => Math.max(this.bandwidth(l, 0).bw, this.bandwidth(l, 1).bw)))
    const widthOf = (bw: number) => this.stripWidth(bw)
    this.strips = []
    const endY = new Map<number, { y: number; w: number }[]>()   // bus attachment -> strip ends
    for (const l of lay.links) {
      if (l.kind === 'self') {
        this.layoutLoop(ctx, l, X, Y, widthOf)
        continue
      }
      // Its strips (layout.channelStrips): a one-way strip per direction with traffic over
      // the run, forward first (with the channels separate: per channel, read first).
      l.strips.forEach((st, i) => {
        const y = this.slotY(Y, l.yc, l.slot + i, l.slots)
        const w = widthOf(this.bandwidth(l, st.dir ?? 0).bw)
        for (const att of l.ends) endY.set(att, [...(endY.get(att) ?? []), { y, w }])
        if (y > -80 && y < this.height + 80) this.layoutStrip(ctx, l, X, y, w, st)
      })
    }
    // Buses: each spans the strips that end on it.
    this.busBoxes = []
    for (const b of lay.buses) {
      const ends = b.atts.flatMap((a) => endY.get(a) ?? [])
      if (!ends.length) continue
      this.busBoxes.push({ x: X(b.x), y0: Math.min(...ends.map((e) => e.y - e.w / 2)) - BOX_PAD,
        y1: Math.max(...ends.map((e) => e.y + e.w / 2)) + BOX_PAD, label: b.label, cls: b.cls, path: b.path, atts: b.atts })
    }
    ctx.restore()
    this.drawGutter(ctx, lay, Y, labelW)
    this.stats.drawMs.push(performance.now() - t0)
    if (this.stats.drawMs.length > 2000) this.stats.drawMs.splice(0, 1000)
  }

  /** One strip of a link, of its direction (null: a link with no traffic over the run) and
   * channel, from
   * x0 to x1 at y, w high: its body with a droplet flare at each end. A link with no traffic
   * in the range is a thin line in its class color when its class collapses, else a full
   * strip at 0 % with a still pattern; a link that the dump did not record is a dashed grey
   * line. */
  private layoutStrip(ctx: CanvasRenderingContext2D, l: PLink, X: (x: number) => number, y: number, w: number,
    st: PStrip): void {
    const k = st.dir
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
      this.strips.push({ link: l, kind: 'line', a, b, y, w: 1, mode: 'still', vTop: 0, vBot: 0, unlimited: false, dir: k ?? 0, ch: st.ch })
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
    const speed = still ? 0 : this.dirLoad(l, k, st.ch).util * MAX_SPEED
    this.strips.push({ link: l, kind: 'bar', a: a + f, b: b - f, y, w, mode: still ? 'still' : 'uni',
      vTop: sign * speed, vBot: 0, pointsRight: sign > 0, unlimited, dir: k ?? 0, ch: st.ch })
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
    this.clipPlot(ctx)
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
    ctx.restore()
  }

  /** "32 % · 164 B/cycle" on a strip (format.ts: "<0.1 % · 0.01 B/cycle"), in its longest segment free of the boxes drawn over
   * it; when that does not fit, the short form "32 %"; when neither fits, nothing (the
   * tooltip has the values). Each strip (and loop leg) shows its own direction. */
  private stripText(ctx: CanvasRenderingContext2D, s: Strip, boxes: { x0: number; x1: number; y0: number; y1: number }[]): 'full' | 'short' | null {
    const th = this.theme
    const l = s.link
    const ch = s.ch ?? 'all'
    const v = this.dirLoad(l, s.dir, ch)
    const unit = String(this.trace.dims.resources[l.fwd ?? l.members[0] ?? 0]?.unit ?? 'B')
    const share = pct(v.util)
    // A write channel or write port sets it (or it is a write strip): marked "w".
    const w = (ch === 'write' || (ch === 'all' && v.write)) && v.rate > 0 ? 'w ' : ''
    const full = v.rate > 0 ? `${w}${share} · ${rate(v.rate, null, unit)}` : share
    const short = `${w}${share}`
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
    this.clipPlot(ctx)
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
    ctx.restore()
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
    if (x < this.plotLeft - 6) return null // the label column hides the plot scrolled under it
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

/** A name in the gutter: an open node, or a closed group of nodes (its box), `nest` open
 * nodes deep; its span [y0, y1) (px), where its name is drawn (yt: NaN when not drawn) and
 * the width of the name drawn (`full`: of the whole name). */
export interface GutterLabel {
  key: string
  kind: 'node' | 'agg'
  label: string
  nest: number
  y0: number
  y1: number
  x: number
  yt: number
  w: number
  full: number
}

/** The x (px) of a gutter name nested `nest` deep (1: below the root). */
function indent(nest: number): number {
  return 10 + 10 * (nest - 1)
}
