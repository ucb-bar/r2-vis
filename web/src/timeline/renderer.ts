// The timeline renderer: one canvas, the visible rows only. Layout: label gutter on the
// left, time axis on top, rows below (group headers, task lanes, utilization lines).
// The renderer holds the view state; Timeline.tsx turns input into calls on it.
import type { Attribution, AttributionRequest, OwnerGroup, Usage, UsageRequest } from '../data/attribution'
import type { ChargeCache, ChargeGroup } from '../data/charges'
import { isDict } from '../data/columns'
import { taskLabel, taskName } from '../data/labels'
import { programSpans, type ProgramSpan } from '../data/programs'
import type { WorkerPool } from '../data/pool'
import type { Trace } from '../data/trace'
import { amount as formatAmount, count, cycles, num, pct, rate, relative, short, splitPath } from '../ui/format'
import { TIP_ITEMS, tipList, type TipContent, type TipItem, type TipRow, type TipSection } from '../ui/Tooltip'
import type { BlockSelection } from '../state/blocks'
import { DEFAULT_PREFS, type ViewPrefs } from '../state/viewprefs'
import type { Theme } from '../theme/theme'
import { lineSlots, taskSlots, type LegendEntry } from './colors'
import { ArrowBatch, DepIndex, type ArrowStyle } from './deps'
import { drawLane, taskAt, wideTasks, type ChunkIndex } from './lanes'
import { blend, LaneRaster, pack, rgba, RowRaster, type RowColors, type SlotColors } from './raster'
import { homeRange, MAX_ROW_HEIGHT, MIN_ROW_HEIGHT, recorded, recordedAt, recordedPart, rowAt, RowSource, type Recorded, type Row, type RowModel } from './rows'
import { chargesAmount, lanesHeld, rangeAmount, sampleBins, sampleCharges, sampleFabric, smooth } from './util'
import { AXIS, GUTTER, TimeAxis, type Range } from './axis'
import { tickStep, type Viewport } from './viewport'

export { AXIS, GUTTER, type Range } from './axis'
const LINE_PAD = 4
export const MAX_SMOOTH = 64
export const DEP_MIN_PX = 4
export const MAX_ARROWS = 5000
/** Minimum width (px) of a task on a Neutrino lane (join, spawn: not wide but important). */
export const NEUTRINO_TICK = 3

export interface ResourceInfo {
  name: string
  unit: string
  ceiling: number | null
  rate: number | null
  /** slots per core cycle (resources.capacity; the lanes before format 1.6; 1 for a v1.0
   * trace), null if unlimited */
  capacity: number | null
  cls: string
  levelRow: number
}

export interface Hover {
  x: number            // canvas CSS px
  y: number
  row: number          // row index or -1
  t: number            // time under the cursor
}

export interface FrameStats {
  drawMs: number[]
  frameAt: number[]
}

interface RowValue {
  value: number        // units per cycle (resource rows) or fraction of ceiling (fabric rows)
  scale: number        // the 100 % value in the same unit
  marked: boolean      // an average (window or selection), not the instant value
  exact: boolean
  member: number       // fabric rows: the port (resource) that gives the value, else -1
  recorded: boolean    // false: the cursor or range is outside the recorded window
}

/** The pool worker of the attribution queries. */
const ATTRIBUTION_WORKER = 0

/** A usage arrow (views-design 7.1): a selected task to a resource row it charged. */
export interface UsageArrow {
  task: number
  /** the row index, -1 if the resource has no row shown */
  row: number
  /** the time of the largest charge (the arrow's end) */
  t: number
  /** the label: the task's peak band height on the row, the largest amount / (ceiling x
   * span) of its charges there (a node: over its members) */
  peak: number
  /** the task's own amount on the row (a node: its members of one unit summed, bytes if
   * they mix units), and the unit */
  amount: number
  unit: string
  /** the task's share of the row's amount over [a, b), its lifetime (the hover tooltip and
   * the order) */
  share: number
  /** the most lanes the task held at once on one of the row's resources, of its lanes
   * (null without lanes) */
  peakLanes: number | null
  lanes: number | null
  exact: boolean
  name: string
  resources: number[]
  a: number
  b: number
}

/** What a flightline goes to (views-design 7). */
export type AttributeTo = 'auto' | 'task' | 'laneKind' | 'kind'
export const MODE_NAME: Record<Exclude<AttributeTo, 'auto'>, string> = { task: 'task', laneKind: 'lane + kind', kind: 'kind' }

/** An owner or a group of owners that a flightline goes to. */
export interface AttributionTarget {
  value: number
  name: () => string
  /** a group: its kind, in the flightline label */
  short: string
  tasks: number
  point: () => { x: number; y: number; shown: boolean; name: string } | null
}

export class TimelineRenderer {
  readonly trace: Trace
  readonly charges: ChargeCache
  readonly pool: WorkerPool
  readonly blocks: BlockSelection
  readonly rec: Recorded
  readonly source: RowSource
  readonly slots: Uint8Array
  readonly legend: LegendEntry[]
  readonly chunks: ChunkIndex
  readonly res: ResourceInfo[]
  readonly deps: DepIndex
  collapsed: Set<number>
  hidden = new Set<string>()
  heights = new Map<string, number>()
  order = new Map<string, string[]>()
  smoothing = 1
  showAllDeps = false
  model: RowModel
  /** The window, selection, zoom box and pin (shared code with the Instant scrubber). */
  readonly axis: TimeAxis
  scrollY = 0
  height = 1
  hover: Hover | null = null
  /** Selected tasks (task rows) of the shared state: arrows stay shown. */
  selectedTasks: ReadonlySet<number> = new Set()
  /** Row reorder preview: the dragged row and the row index it goes before. */
  reorder: { from: number; before: number } | null = null
  readonly selectedRows = new Set<string>()
  /** The row the minimap shows (the last row whose label was clicked). */
  focusKey: string | null = null
  /** Attribution (views-design 7): the owners of the selected resource row at the cursor
   * or over the range, and the most flightlines drawn. */
  attribution: { key: string; res: Attribution } | null = null
  maxFlightlines = 32
  /** What a flightline goes to; auto: the tasks while they fit maxFlightlines, else the
   * (lane, kind) groups, else the kind groups. */
  attributeTo: AttributeTo = 'auto'
  /** Reverse attribution (views-design 7.1): the charges of the selected tasks, and the
   * sidebar switch. */
  usage: { key: string; tasks: number[]; res: Usage; byRes: Map<number, [number, number]> } | null = null
  showUsage = true
  /** Control traffic (protocol messages) and Neutrino scalar work (the invoke cost at the
   * call, planning, waits) are attributed: off by default, since the control runs ahead of
   * the tasks. The completion port stays attributed. */
  controlTraffic = false
  /** Called when a usage query returns (the view redraws). */
  onUsage: (() => void) | null = null
  private usageAsked = ''
  /** the usage arrow labels drawn last (their hover tooltip) */
  private arrowHits: { x0: number; x1: number; y0: number; y1: number; arrow: UsageArrow }[] = []
  /** resource amounts over task lifetimes (usage arrows), per usage */
  private readonly usageTotals = new Map<string, { amount: number; exact: boolean }>()
  private arrowCache: { usage: NonNullable<TimelineRenderer['usage']>; model: RowModel; control: boolean; arrows: UsageArrow[] } | null = null
  private readonly usageCaps: { ceiling: Float64Array }
  /** Called when an attribution query returns (the view redraws). */
  onAttribution: (() => void) | null = null
  private attributionAsked = ''
  readonly stats: FrameStats = { drawMs: [], frameAt: [] }
  /** Test switches (benchmarks only). */
  debug = { noLanes: false, flush: false, portsFabric: false }
  /** Per row index: the drawn (smoothed) and raw samples of the last frame. */
  readonly sampled = new Map<number, { shown: Float64Array; raw: Float64Array; argmax: Int32Array | null }>()
  private themeValue: Theme
  private raw = new Float64Array(0)
  private shown = new Float64Array(0)
  private peak = new Float64Array(0)
  private ys = new Float64Array(0)
  private diff = new Float64Array(0)
  private readonly raster = new RowRaster()
  private readonly laneRaster = new LaneRaster()
  private slotColors: SlotColors[] | null = null
  private readonly rowColors = new Map<string, RowColors>()
  private memberRaw = new Float64Array(0)
  private scratchPeak = new Float64Array(0)
  readonly lineSlots: string[]
  fabricOpen = new Set<string>()
  private barInk: string[] = []
  private gridX: number[] = []
  private dpr = 1
  private depNote = false
  private readonly programsOf: Map<number, ProgramSpan[]>
  /** Called after a change of the persisted view state, and after a view change. */
  onPrefs: (() => void) | null = null

  constructor(trace: Trace, charges: ChargeCache, pool: WorkerPool, blocks: BlockSelection,
    theme: Theme, prefs: ViewPrefs) {
    this.axis = new TimeAxis(trace.manifest.end_time, homeRange(trace))
    this.trace = trace
    this.charges = charges
    this.pool = pool
    this.blocks = blocks
    this.themeValue = theme
    this.rec = recorded(trace)
    this.source = new RowSource(trace, this.rec)
    const { slots, legend } = taskSlots(trace)
    this.slots = slots
    this.legend = legend
    const tc = trace.facts.tasks.cols
    const cc = trace.facts.chunks.cols
    this.chunks = { first: trace.lanes.chunkFirst, count: tc.n_chunks as Int32Array,
      start: cc.start as Float64Array, end: cc.end as Float64Array }
    this.deps = new DepIndex(trace)
    this.lineSlots = lineSlots(trace)
    this.res = trace.dims.resources.map((r) => ({
      name: String(r.name), unit: String(r.unit ?? ''), ceiling: r.ceiling as number | null,
      rate: r.rate as number | null, cls: String(r.class ?? ''),
      capacity: (r.capacity as number | null | undefined) ?? null,
      levelRow: trace.levels.rowOf[r.id as number] ?? -1,
    }))
    this.collapsed = this.source.initialCollapsed()
    this.applyPrefs(prefs, false)
    this.model = this.build()
    this.focusKey = this.busiestCompute()
    this.programsOf = programSpans(trace)
    const resources = trace.dims.resources
    this.usageCaps = { ceiling: Float64Array.from(resources, (r) => (r.ceiling as number | null) ?? 0) }
  }

  // ---- state ----------------------------------------------------------------------------

  get view(): Viewport { return this.axis.view }
  get width(): number { return this.axis.width }
  get selection(): Range | null { return this.axis.selection }
  set selection(r: Range | null) { this.axis.selection = r }
  get zoomBox(): Range | null { return this.axis.zoomBox }
  set zoomBox(r: Range | null) { this.axis.zoomBox = r }
  get pinned(): number | null { return this.axis.pinned }
  set pinned(t: number | null) { this.axis.pinned = t }
  get onView(): (() => void) | null { return this.axis.onView }
  set onView(f: (() => void) | null) { this.axis.onView = f }

  get theme(): Theme {
    return this.themeValue
  }

  set theme(t: Theme) {
    this.themeValue = t
    this.rowColors.clear()
    this.slotColors = null
    this.barInk = []
  }

  get plotWidth(): number {
    return this.axis.plotWidth
  }

  get endTime(): number {
    return this.axis.endTime
  }

  prefs(): ViewPrefs {
    const checked = this.blocks.get()
    return {
      hidden: [...this.hidden],
      heights: Object.fromEntries(this.heights),
      order: Object.fromEntries(this.order),
      smoothing: this.smoothing,
      uncheckedBlocks: this.trace.dims.nodes.filter((n) => !checked.has(n.id as number)).map((n) => String(n.path)),
    }
  }

  applyPrefs(p: ViewPrefs, notify = true): void {
    this.hidden = new Set(p.hidden)
    this.heights = new Map(Object.entries(p.heights))
    this.order = new Map(Object.entries(p.order))
    this.smoothing = Math.max(1, Math.min(MAX_SMOOTH, Math.round(p.smoothing)))
    const unchecked = new Set(p.uncheckedBlocks)
    const ids = this.trace.dims.nodes.filter((n) => !unchecked.has(String(n.path))).map((n) => n.id as number)
    const current = this.blocks.get()
    if (ids.length !== current.size || ids.some((id) => !current.has(id))) this.blocks.set(new Set(ids))
    if (notify) this.changed()
  }

  resetView(): void {
    this.collapsed = this.source.initialCollapsed()
    this.selection = null
    this.selectedRows.clear()
    this.applyPrefs(DEFAULT_PREFS)
  }

  private build(): RowModel {
    return this.source.build({ collapsed: this.collapsed, fabricOpen: this.fabricOpen, hidden: this.hidden,
      heights: this.heights, order: this.order, checked: this.blocks.get() })
  }

  rebuild(): void {
    this.model = this.build()
  }

  private changed(): void {
    this.rebuild()
    this.onPrefs?.()
  }

  private busiestCompute(): string | null {
    let best: Row | null = null
    let bestBusy = -1
    for (const r of this.model.rows) {
      if (r.kind !== 'resource' || this.res[r.id].cls !== 'compute') continue
      const busy = this.trace.dims.resources[r.id].busy_cycles as number
      if (busy > bestBusy) { best = r; bestBusy = busy }
    }
    return best?.key ?? this.model.rows.find((r) => r.kind === 'resource')?.key ?? null
  }

  /** The row of the minimap, if it is shown. */
  focusRow(): Row | null {
    return this.model.rows.find((r) => r.key === this.focusKey) ?? null
  }

  resize(width: number, height: number): void {
    this.height = height
    this.axis.resize(width)
  }

  setView(v: Viewport): void {
    this.axis.setView(v)
  }

  zoom(xPlot: number, factor: number): void {
    this.axis.zoom(xPlot, factor)
  }

  pan(dxPx: number): void {
    this.axis.pan(dxPx)
  }

  zoomTo(r: Range): void {
    this.axis.zoomTo(r)
  }

  toggle(node: number): void {
    if (this.collapsed.has(node)) this.collapsed.delete(node)
    else this.collapsed.add(node)
    this.rebuild()
  }

  hideSelected(): number {
    let n = 0
    for (const k of this.selectedRows) {
      this.hidden.add(k)
      n++
    }
    this.selectedRows.clear()
    if (n) {
      this.changed()
      if (this.focusKey && this.hidden.has(this.focusKey)) this.focusKey = this.busiestCompute()
    }
    return n
  }

  /** The hidden rows of a node (key and label), the rows inside its fabric nodes included. */
  hiddenOf(node: number): { key: string; label: string }[] {
    const out: { key: string; label: string }[] = []
    const visit = (r: Row, prefix: string) => {
      if (this.hidden.has(r.key)) out.push({ key: r.key, label: `${prefix}${r.label}` })
      if (r.kind === 'fabric') for (const m of this.source.fabrics[r.id].members_rows) visit(m, `${prefix}${r.label} › `)
    }
    for (const r of this.source.ownRowsOf(node)) visit(r, '')
    return out
  }

  /** Opens or closes a fabric node. */
  toggleFabric(key: string): void {
    if (this.fabricOpen.has(key)) this.fabricOpen.delete(key)
    else this.fabricOpen.add(key)
    this.rebuild()
  }

  restore(keys: string[]): void {
    for (const k of keys) this.hidden.delete(k)
    this.changed()
  }

  setHeight(key: string, h: number | null): void {
    if (h === null) this.heights.delete(key)
    else this.heights.set(key, Math.max(MIN_ROW_HEIGHT, Math.min(MAX_ROW_HEIGHT, Math.round(h))))
    this.rebuild()
  }

  /** Persists the heights after a resize drag. */
  commitHeights(): void {
    this.onPrefs?.()
  }

  /** Moves row `from` before row `before` (row indices), inside its container (a node's
   * own rows, or a fabric node's rows). */
  moveRow(from: number, before: number): void {
    const rows = this.model.rows
    const row = rows[from]
    const container = row.parent
    // The container's rows in their current order; the hidden ones keep their place at the end.
    const shown = rows.filter((r) => r.parent === container && r.kind !== 'group').map((r) => r.key)
    const rest = this.source.rowsIn(container).map((r) => r.key).filter((k) => !shown.includes(k))
    const target = before < rows.length && rows[before].parent === container && rows[before].kind !== 'group'
      ? rows[before].key : null
    const keys = shown.filter((k) => k !== row.key)
    const at = target === null ? keys.length : keys.indexOf(target)
    keys.splice(at < 0 ? keys.length : at, 0, row.key)
    this.order.set(container, [...keys, ...rest])
    this.changed()
  }

  setSmoothing(px: number): void {
    this.smoothing = Math.max(1, Math.min(MAX_SMOOTH, Math.round(px)))
    this.onPrefs?.()
  }

  /** Row index at canvas y, or -1 (the axis band is not a row). */
  rowAtY(y: number): number {
    if (y < AXIS) return -1
    return rowAt(this.model, y - AXIS + this.scrollY)
  }

  rowTop(i: number): number {
    return AXIS + this.model.top[i] - this.scrollY
  }

  timeAtX(x: number): number {
    return this.axis.timeAtX(x)
  }

  xOf(t: number): number {
    return this.axis.xOf(t)
  }

  // ---- drawing --------------------------------------------------------------------------

  draw(ctx: CanvasRenderingContext2D, dpr: number): void {
    const t0 = performance.now()
    const th = this.theme
    const W = this.width
    const H = this.height
    const pw = this.plotWidth
    this.dpr = dpr
    this.requestUsage()
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = th.surface
    ctx.fillRect(0, 0, W, H)
    const n = Math.ceil(pw)
    const m = MAX_SMOOTH
    if (this.raw.length < n + 2 * m + 2) {
      this.raw = new Float64Array(n + 2 * m + 2)
      this.shown = new Float64Array(n + 2)
      this.peak = new Float64Array(n + 2 * m + 2)
      this.ys = new Float64Array(n + 2)
      this.diff = new Float64Array(n + 2 * m + 3)
      this.memberRaw = new Float64Array(n + 2 * m + 2)
      this.scratchPeak = new Float64Array(n + 2 * m + 2)
    }
    this.sampled.clear()
    const step = tickStep(this.view.cpp, 90)

    // Vertical grid under the rows.
    ctx.strokeStyle = th.grid
    ctx.lineWidth = 1
    ctx.beginPath()
    this.gridX = []
    for (let t = Math.ceil(this.view.t0 / step) * step; t < this.view.t0 + pw * this.view.cpp; t += step) {
      const x = Math.round(this.xOf(t)) + 0.5
      this.gridX.push(x - 0.5 - GUTTER)
      ctx.moveTo(x, AXIS)
      ctx.lineTo(x, H)
    }
    ctx.stroke()

    // Charges for the detail mode (pixels narrower than one bin), with the smoothing margin.
    const detail = this.view.cpp < this.trace.levels.width
    const groups = detail
      ? this.chargeGroups(this.view.t0 - m * this.view.cpp, this.view.t0 + (pw + m) * this.view.cpp) : null

    const first = Math.max(0, rowAt(this.model, this.scrollY))
    const bottom = this.scrollY + H - AXIS
    for (let i = first; i < this.model.rows.length && this.model.top[i] < bottom; i++) {
      this.drawRow(ctx, i, this.model.rows[i], this.rowTop(i), groups)
    }
    ctx.save()
    ctx.beginPath()
    ctx.rect(GUTTER, AXIS, pw, H - AXIS)
    ctx.clip()
    this.drawDeps(ctx)
    this.drawFlightlines(ctx)
    this.drawUsageArrows(ctx)
    this.drawWindowShade(ctx)
    ctx.restore()
    this.axis.drawBands(ctx, th, AXIS, this.height)
    this.drawReorder(ctx)
    this.axis.drawAxis(ctx, th)
    this.axis.drawCursor(ctx, th, AXIS, this.height, this.hover?.x ?? null)
    if (this.debug.flush) ctx.getImageData(0, 0, 1, 1)
    const dt = performance.now() - t0
    this.stats.drawMs.push(dt)
    this.stats.frameAt.push(t0)
    if (this.stats.drawMs.length > 2000) {
      this.stats.drawMs.splice(0, 1000)
      this.stats.frameAt.splice(0, 1000)
    }
  }

  /** The loaded charge groups of [a, b), or null while some are loading (they are
   * requested; the view redraws when they arrive). */
  chargeGroups(a: number, b: number): ChargeGroup[] | null {
    const out: ChargeGroup[] = []
    let missing = false
    for (const blk of this.charges.groupsFor(a, b)) {
      const g = this.charges.peek(blk.group)
      if (g) out.push(g)
      else {
        missing = true
        void this.charges.get(blk)
      }
    }
    return missing ? null : out
  }

  private drawRow(ctx: CanvasRenderingContext2D, index: number, row: Row, y: number,
    groups: ChargeGroup[] | null): void {
    const th = this.theme
    const indent = 10 + row.depth * 12
    ctx.textBaseline = 'middle'
    if (row.kind === 'group') {
      ctx.fillStyle = th.page
      ctx.fillRect(0, y, this.width, row.height)
      ctx.fillStyle = th.inkSecondary
      this.triangle(ctx, indent - 6, y + row.height / 2, !this.collapsed.has(row.id))
      ctx.fillStyle = th.ink
      ctx.font = `600 ${th.fontSizeS}px ${th.fontSans}`
      const nHidden = this.hiddenOf(row.id).length
      const suffix = row.notRecorded ? '  (not recorded)' : nHidden ? `  (${nHidden} hidden)` : ''
      this.text(ctx, row.label + suffix, indent + 6, y + row.height / 2, GUTTER - indent - 10)
      ctx.font = `${th.fontSizeS}px ${th.fontSans}`
      this.drawPrograms(ctx, row.id, y, row.height)
    } else {
      if (this.selectedRows.has(row.key)) {
        ctx.fillStyle = th.accentArea
        ctx.fillRect(0, y, GUTTER, row.height - 1)
      }
      if (row.key === this.focusKey) {
        ctx.fillStyle = th.accent
        ctx.fillRect(0, y, 3, row.height - 1)
      }
      ctx.font = `${th.fontSizeS}px ${th.fontSans}`
      let labelX = indent + 6
      if (row.kind === 'fabric') {
        ctx.fillStyle = th.inkSecondary
        this.triangle(ctx, indent, y + row.height / 2, this.fabricOpen.has(row.key))
        labelX += 8
      }
      // A color chip: the row's line color (fabric and compute families).
      if (row.kind === 'resource' || row.kind === 'fabric') {
        ctx.fillStyle = this.lineColorOf(row)
        ctx.fillRect(labelX, y + row.height / 2 - 4, 3, 8)
        labelX += 7
      }
      ctx.fillStyle = row.notRecorded ? th.inkMuted : th.inkSecondary
      const series = row.kind === 'resource' || row.kind === 'fabric'
      this.text(ctx, row.label, labelX, y + row.height / 2, GUTTER - labelX - (series ? 92 : 10))
      if (row.notRecorded) this.notRecorded(ctx, y, row.height)
      else if (row.kind === 'lane') {
        if (!this.debug.noLanes) this.drawLaneRow(ctx, row, y)
      } else if (series) this.drawSeries(ctx, index, row, y, groups)
    }
    ctx.fillStyle = th.grid
    ctx.fillRect(0, y + row.height - 1, this.width, 1)
  }

  /** Samples one resource over the view (with the smoothing margin) into `out`, in units
   * per cycle; returns whether `peak` holds a peak envelope. */
  private sampleResource(resource: number, groups: ChargeGroup[] | null, out: Float64Array,
    peak: Float64Array | null): boolean {
    const info = this.res[resource]
    const m = MAX_SMOOTH
    const total = Math.ceil(this.plotWidth) + 2 * m
    const ts = this.view.t0 - m * this.view.cpp
    if (groups) {
      sampleCharges(groups, resource, ts, this.view.cpp, total, out, this.diff)
      return false
    }
    if (info.levelRow >= 0) return sampleBins(this.trace.levels, info.levelRow, ts, this.view.cpp, total, out, peak ?? this.scratchPeak)
    out.fill(0, 0, total)
    return false
  }

  /** A resource row (units per cycle against its ceiling), or a fabric row (the largest
   * fraction of ceiling over its ports: per bin from the precomputed series, per pixel
   * from the charges). */
  private drawSeries(ctx: CanvasRenderingContext2D, index: number, row: Row, y: number,
    groups: ChargeGroup[] | null): void {
    const th = this.theme
    const n = Math.ceil(this.plotWidth)
    const m = MAX_SMOOTH
    const total = n + 2 * m
    let scale: number
    let hasPeak = false
    let argmax: Int32Array | null = null
    const fabricRow = row.kind === 'fabric' ? this.trace.fabricRow.get(this.source.fabrics[row.id].path) : undefined
    const fl = this.trace.levels.fabric
    if (row.kind === 'fabric' && !groups && fl && fabricRow !== undefined && !this.debug.portsFabric) {
      // Bins: the precomputed MAX series (per level, the busiest port's average).
      scale = 1
      const cpp = this.view.cpp
      argmax = new Int32Array(n).fill(-1)
      const arg = new Int32Array(total)
      hasPeak = sampleFabric(fl, fabricRow, this.view.t0 - m * cpp, cpp, total, this.raw, this.peak, arg)
      argmax.set(arg.subarray(m, m + n))
    } else if (row.kind === 'fabric') {
      // Charges: the exact per-pixel maximum over the ports.
      const f = this.source.fabrics[row.id]
      scale = 1
      this.raw.fill(-1, 0, total)
      argmax = new Int32Array(n).fill(-1)
      for (const r of f.members) {
        const c = this.res[r].ceiling
        if (!c) continue
        this.sampleResource(r, groups, this.memberRaw, null)
        for (let k = 0; k < total; k++) {
          const v = this.memberRaw[k] / c
          if (v > this.raw[k]) {
            this.raw[k] = v
            if (k >= m && k < m + n) argmax[k - m] = r
          }
        }
      }
      for (let k = 0; k < total; k++) if (this.raw[k] < 0) this.raw[k] = 0
    } else {
      scale = this.res[row.id].ceiling ?? 0
      hasPeak = this.sampleResource(row.id, groups, this.raw, this.peak)
    }
    smooth(this.raw, m, n, this.smoothing, this.shown)
    this.sampled.set(index, { shown: this.shown.slice(0, n), raw: this.raw.slice(m, m + n), argmax })
    const h = row.height - 2 * LINE_PAD - 1
    const base = LINE_PAD + h
    const yOf = (v: number) => base - Math.min(1.08, scale > 0 ? v / scale : 0) * h
    const ys = this.ys
    for (let p = 0; p < n; p++) ys[p] = yOf(this.shown[p])
    let peaks: Float64Array | null = null
    if (hasPeak) {
      peaks = this.peak.subarray(m, m + n)
      for (let p = 0; p < n; p++) peaks[p] = yOf(peaks[p])
    }
    this.raster.draw(ctx, this.dpr, GUTTER, y, n, row.height - 1, ys, peaks, this.gridX, LINE_PAD, base,
      this.colorsFor(this.lineColorOf(row)))
    this.drawUsage(ctx, row, y, n, base, h)
    // Left label: the value at the cursor, else the average over the range or window.
    const v = this.rowValue(index, row)
    const frac = v.scale > 0 ? v.value / v.scale : NaN
    const mark = v.marked ? (v.exact ? 'avg ' : 'avg ≈') : ''
    const text = !v.recorded ? 'not recorded' : frac === frac ? `${mark}${pct(frac)}` : '–'
    ctx.textAlign = 'right'
    ctx.fillStyle = v.marked || !v.recorded ? th.inkMuted : th.ink
    ctx.fillText(text, GUTTER - 10, y + row.height / 2)
    ctx.textAlign = 'left'
  }

  /** Value of a series row for its label (views-design 7: not the hover): at the cursor
   * (the plotted, smoothed value when the cursor is in the window, else the cycle at the
   * cursor), else the average over the selection, else over the window. A fabric row gives
   * the busiest port: the largest average fraction of ceiling. */
  rowValue(index: number, row: Row): RowValue {
    const s = this.sampled.get(index)
    const scale = row.kind === 'fabric' ? 1 : this.res[row.id].ceiling ?? 0
    const at = this.pinned
    if (at !== null && !recordedAt(this.rec.window, at)) return { value: 0, scale, marked: false, exact: true, member: -1, recorded: false }
    if (at !== null) {
      const p = Math.floor(this.xOf(at) - GUTTER)
      if (s && p >= 0 && p < s.shown.length) {
        return { value: s.shown[p], scale, marked: false, exact: true, member: s.argmax?.[p] ?? -1, recorded: true }
      }
    }
    const r = at !== null ? { a: at, b: at + 1 } : this.activeRange()
    if (row.kind === 'fabric') {
      let best = 0
      let member = -1
      let exact = true
      const rec = recordedPart(this.rec.window, r.a, r.b) !== null
      for (const res of rec ? this.source.fabrics[row.id].members : []) {
        const c = this.res[res].ceiling
        if (!c) continue
        const avg = this.average(res, r)
        exact &&= avg.exact
        if (avg.value / c >= best) { best = avg.value / c; member = res }
      }
      return { value: best, scale, marked: true, exact, member, recorded: rec }
    }
    const avg = this.average(row.id, r)
    return { value: avg.value, scale, marked: true, exact: avg.exact, member: -1, recorded: avg.recorded }
  }

  /** The selection, else the visible window clipped to the run. */
  activeRange(): Range {
    return this.selection && this.selection.b > this.selection.a ? this.selection
      : { a: Math.max(0, this.view.t0), b: Math.min(this.endTime, this.view.t0 + this.plotWidth * this.view.cpp) }
  }

  /** Average throughput of a resource over [a, b) (units per cycle). Exact from the bins
   * and, at partial bins, from the charges when they are loaded. */
  average(resource: number, range: Range): { value: number; exact: boolean; recorded: boolean } {
    const info = this.res[resource]
    // Over the part inside the recorded window: outside it the load is unknown.
    const r = recordedPart(this.rec.window, range.a, range.b)
    if (!r) return { value: 0, exact: true, recorded: false }
    const span = r.b - r.a
    if (info.levelRow < 0) return { value: 0, exact: true, recorded: true }
    const edge = (x: number, y: number): number | null => {
      const g = this.chargeGroups(x, y)
      return g ? chargesAmount(g, resource, x, y) : null
    }
    const { amount, exact } = rangeAmount(this.trace.levels, info.levelRow, r.a, r.b, edge)
    return { value: amount / span, exact, recorded: true }
  }

  /** Line color of a series row (fabric rows and their members share the hue). */
  lineColorOf(row: Row): string {
    const resource = row.kind === 'fabric' ? this.source.fabrics[row.id].members[0] : row.id
    return this.theme.lines[this.lineSlots[resource]] ?? this.theme.accent
  }

  private colorsFor(line: string): RowColors {
    let c = this.rowColors.get(line)
    if (!c) {
      const th = this.themeValue
      const surface = rgba(th.surface)
      const lc = rgba(line)
      c = {
        surface: pack(surface), grid: pack(blend(rgba(th.grid), surface)),
        peak: pack(blend(rgba(th.grid), surface)), area: pack(blend([lc[0], lc[1], lc[2], 46], surface)),
        line: pack(blend(lc, surface)), ceiling: pack(blend(rgba(th.inkMuted), surface)),
      }
      this.rowColors.set(line, c)
    }
    return c
  }

  private colors(): RowColors {
    return this.colorsFor(this.themeValue.accent)
  }

  /** Text color on a bar of each slot: dark or light ink by the bar's luminance. */
  private inkOn(slot: number): string {
    if (this.barInk.length === 0) {
      const th = this.themeValue
      this.barInk = [...th.series, th.seriesOther].map((c) => {
        const [r, g, b] = rgba(c).map((v) => {
          const s = v / 255
          return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
        })
        return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.25 ? th.inkOnLight : th.inkOnDark
      })
    }
    return this.barInk[slot]
  }

  private lanePalette(): SlotColors[] {
    if (!this.slotColors) {
      const th = this.themeValue
      const surface = rgba(th.surface)
      const sheer: [number, number, number, number] = [surface[0], surface[1], surface[2], 140]
      this.slotColors = [...th.series, th.seriesOther].map((c) => {
        const bar = blend(rgba(c), surface)
        return { bar: pack(bar), chunk: pack(blend(sheer, bar)) }
      })
    }
    return this.slotColors
  }

  /** Bar area of a lane row: top padding and height (CSS px). */
  private laneBox(row: Row): { pad: number; h: number; subH: number } {
    const pad = Math.min(3, Math.floor(row.height / 6))
    const h = row.height - 2 * pad
    return { pad, h, subH: h / this.trace.lanes.depth[row.id] }
  }

  /** A task lane: bars and busy columns rasterized into the row, then the bar labels. */
  private drawLaneRow(ctx: CanvasRenderingContext2D, row: Row, y: number): void {
    const n = Math.ceil(this.plotWidth)
    const { pad, h } = this.laneBox(row)
    const lr = this.laneRaster
    const c = this.colors()
    lr.slots = this.lanePalette()
    lr.begin(this.dpr, n, row.height - 1, pad, c.surface, c.grid, this.gridX)
    drawLane(lr, this.trace.lanes, row.id, this.slots, this.chunks, this.view, n, h, this.isNeutrinoLane(row.id) ? NEUTRINO_TICK : 0)
    lr.put(ctx, GUTTER, y)
    this.drawBarLabels(ctx, lr.bars, y + pad)
  }

  private drawBarLabels(ctx: CanvasRenderingContext2D,
    bars: { task: number; x: number; y: number; w: number; h: number }[], y: number): void {
    const th = this.theme
    if (bars.length === 0) return
    ctx.font = `${th.fontSizeXs}px ${th.fontSans}`
    ctx.textBaseline = 'middle'
    const version = this.trace.facts.tasks.cols.version as Int32Array
    for (const bar of bars) {
      if (bar.h < th.fontSizeXs - 1) continue
      const left = Math.max(bar.x, 0)
      const room = Math.min(bar.x + bar.w, this.plotWidth) - left - 6
      const v = version[bar.task]
      const vtext = v >= 0 ? `v${v}` : ''
      const name = room > 40 ? this.taskName(bar.task) : null
      let text = ''
      if (name) {
        const full = vtext ? `${name} ${vtext}` : name
        if (ctx.measureText(full).width <= room) text = full
      }
      if (!text && vtext && ctx.measureText(vtext).width <= room) text = vtext
      if (!text) continue
      ctx.fillStyle = this.inkOn(this.slots[bar.task])
      ctx.fillText(text, GUTTER + left + 3, y + bar.y + bar.h / 2)
    }
  }

  // ---- dependencies ---------------------------------------------------------------------

  /** A task's bar end (`end`: complete, else issue) on the canvas; null if its lane row is
   * not shown. `onScreen` is false when the row or the time is off the plot. */
  private taskPoint(task: number, end: boolean): { x: number; y: number; onScreen: boolean } | null {
    const c = this.trace.facts.tasks.cols
    const lane = (c.lane as Int32Array)[task]
    const ri = this.model.rowOfLane[lane]
    if (ri < 0) return null
    const t = end ? (c.complete as Float64Array)[task] : (c.issue as Float64Array)[task]
    const x = this.xOf(t === t ? t : this.endTime)
    const { pad, subH } = this.laneBox(this.model.rows[ri])
    const y = this.rowTop(ri) + pad + (this.trace.lanes.taskSub[task] + 0.5) * subH
    const onScreen = x >= GUTTER && x <= this.width && y >= AXIS && y <= this.height
    return { x, y, onScreen }
  }

  private laneName(task: number): string {
    const lane = (this.trace.facts.tasks.cols.lane as Int32Array)[task]
    return short(String(this.trace.dims.lanes[lane]?.path ?? ''))
  }

  isNeutrinoLane(lane: number): boolean {
    return this.trace.dims.lanes[lane]?.type === 'neutrino'
  }

  /** A task without a PE (join, spawn) runs on its Neutrino lane. */
  isNeutrinoTask(task: number): boolean {
    return (this.trace.facts.tasks.cols.pe as Int32Array)[task] === -1
  }

  /** Arrows on hover: Neutrino tasks always, others when their bar is DEP_MIN_PX wide. */
  arrowsFor(task: number): boolean {
    return this.isNeutrinoTask(task) || this.barWidthPx(task) >= DEP_MIN_PX
  }

  barWidthPx(task: number): number {
    const c = this.trace.facts.tasks.cols
    const iss = (c.issue as Float64Array)[task]
    const cmp = (c.complete as Float64Array)[task]
    return iss === iss && cmp === cmp ? (cmp - iss) / this.view.cpp : 0
  }

  /** An arrow from the producer's complete to the consumer's issue. An end that is not on
   * the plot goes to the plot edge and gets its lane name; a producer outside the trace
   * (no task row) gets a short stub. */
  private arrow(batch: ArrowBatch, style: ArrowStyle, producer: number, consumer: number, labelColor: string): void {
    const top = AXIS + 3
    const bottom = this.height - 3
    const clamp = (p: { x: number; y: number }) => ({
      x: Math.max(GUTTER, Math.min(this.width, p.x)), y: Math.max(top, Math.min(bottom, p.y)),
    })
    if (producer < 0) {
      const c = this.taskPoint(consumer, false)
      if (!c?.onScreen) return
      batch.add(style, c.x - 36, c.y - 12, c.x, c.y)
      batch.label(Math.max(GUTTER, c.x - 36 - 72), c.y - 12, 'outside trace', labelColor)
      return
    }
    const p = this.taskPoint(producer, true)
    const c = this.taskPoint(consumer, false)
    if (!p && !c) return
    const ps = p ? clamp(p) : { x: GUTTER, y: top }
    const cs = c ? clamp(c) : { x: this.width, y: top }
    batch.add(style, ps.x, ps.y, cs.x, cs.y)
    if (!p || !p.onScreen) batch.label(ps.x + 4, ps.y + (ps.y <= top ? 8 : -8), this.laneName(producer), labelColor)
    if (!c || !c.onScreen) batch.label(Math.min(cs.x, this.width - 160), cs.y + (cs.y <= top ? 8 : -8), this.laneName(consumer), labelColor)
  }

  private drawDeps(ctx: CanvasRenderingContext2D): void {
    const th = this.theme
    const batch = new ArrowBatch()
    const strong: ArrowStyle = { color: th.ink, dash: false, width: 1.5, curve: true }
    const strongRemote: ArrowStyle = { ...strong, dash: true }
    const light: ArrowStyle = { color: th.inkMuted, dash: false, width: 1, curve: true }
    const lightRemote: ArrowStyle = { ...light, dash: true }
    this.depNote = false
    if (this.showAllDeps) {
      this.allDeps(batch, { ...light, curve: false }, { ...lightRemote, curve: false })
    }
    const outlines = new Path2D()
    const consumerOutlines = new Path2D()
    const selectedOutlines = new Path2D()
    const withArrows = (task: number) => {
      for (const d of this.deps.producers(task)) {
        this.arrow(batch, d.remote ? strongRemote : strong, d.other, task, th.inkSecondary)
        if (d.other >= 0) this.outline(outlines, d.other)
      }
      for (const d of this.deps.consumers(task, this.pool) ?? []) {
        if (d.other < 0) continue
        this.arrow(batch, d.remote ? lightRemote : light, task, d.other, th.inkMuted)
        this.outline(consumerOutlines, d.other)
      }
    }
    // Selected tasks keep their arrows at any width (the edge rule when off screen).
    for (const t of this.selectedTasks) {
      withArrows(t)
      this.outline(selectedOutlines, t)
    }
    const hovered = this.hoveredTask()
    if (hovered >= 0 && !this.selectedTasks.has(hovered) && this.arrowsFor(hovered)) {
      withArrows(hovered)
      this.outline(outlines, hovered)
    }
    if (this.depNote) {
      ctx.fillStyle = th.inkMuted
      ctx.font = `${th.fontSizeS}px ${th.fontSans}`
      ctx.textBaseline = 'middle'
      ctx.fillText('dependencies: zoom in', GUTTER + 8, AXIS + 10)
    }
    ctx.lineWidth = 1
    ctx.strokeStyle = th.inkMuted
    ctx.stroke(consumerOutlines)
    ctx.lineWidth = 1.5
    ctx.strokeStyle = th.ink
    ctx.stroke(outlines)
    ctx.lineWidth = 2
    ctx.strokeStyle = th.accent
    ctx.stroke(selectedOutlines)
    batch.draw(ctx, `${th.fontSizeXs}px ${th.fontSans}`, th.surface)
  }

  /** "Show all dependencies": producer arrows of every visible task at least DEP_MIN_PX
   * wide, at most MAX_ARROWS; above that, only the note. */
  private allDeps(batch: ArrowBatch, style: ArrowStyle, remote: ArrowStyle): void {
    const th = this.theme
    const pending: [number, number, boolean][] = []
    for (let i = Math.max(0, rowAt(this.model, this.scrollY)); i < this.model.rows.length; i++) {
      if (this.rowTop(i) > this.height) break
      const row = this.model.rows[i]
      if (row.kind !== 'lane' || row.notRecorded) continue
      const minPx = this.isNeutrinoLane(row.id) ? 0 : DEP_MIN_PX
      const tasks = wideTasks(this.trace.lanes, row.id, this.view, this.plotWidth, minPx, MAX_ARROWS)
      if (tasks === null) { this.depNote = true; return }
      for (const t of tasks) {
        for (const d of this.deps.producers(t)) {
          pending.push([d.other, t, d.remote])
          if (pending.length > MAX_ARROWS) { this.depNote = true; return }
        }
      }
    }
    for (const [p, c, r] of pending) this.arrow(batch, r ? remote : style, p, c, th.inkMuted)
  }

  private outline(path: Path2D, task: number): void {
    const c = this.trace.facts.tasks.cols
    const ri = this.model.rowOfLane[(c.lane as Int32Array)[task]]
    if (ri < 0) return
    const iss = (c.issue as Float64Array)[task]
    const cmp = (c.complete as Float64Array)[task]
    if (iss !== iss) return
    const x0 = this.xOf(iss)
    let x1 = this.xOf(cmp === cmp ? cmp : this.endTime)
    if (this.isNeutrinoTask(task)) x1 = Math.max(x1, x0 + NEUTRINO_TICK)
    const { pad, subH } = this.laneBox(this.model.rows[ri])
    const top = this.rowTop(ri) + pad + this.trace.lanes.taskSub[task] * subH
    path.rect(x0 - 0.5, top - 0.5, Math.max(1, x1 - x0) + 1, subH + 1)
  }

  /** The task under the cursor in a lane row, or -1. */
  hoveredTask(): number {
    const h = this.hover
    if (!h || h.row < 0 || h.x < GUTTER) return -1
    const row = this.model.rows[h.row]
    if (row.kind !== 'lane' || row.notRecorded) return -1
    const { pad, subH } = this.laneBox(row)
    const depth = this.trace.lanes.depth[row.id]
    const sub = Math.max(0, Math.min(depth - 1, Math.floor((h.y - this.rowTop(h.row) - pad) / subH)))
    return taskAt(this.trace.lanes, row.id, sub, h.t, 3 * this.view.cpp)
  }

  // ---- other layers ---------------------------------------------------------------------

  private drawReorder(ctx: CanvasRenderingContext2D): void {
    if (!this.reorder) return
    const { before } = this.reorder
    const y = before < this.model.rows.length ? this.rowTop(before) : AXIS + this.model.height - this.scrollY
    ctx.fillStyle = this.theme.accent
    ctx.fillRect(0, Math.round(y) - 1, this.width, 2)
  }

  private drawPrograms(ctx: CanvasRenderingContext2D, node: number, y: number, h: number): void {
    const progs = this.programsOf.get(node)
    if (!progs) return
    const th = this.theme
    const pw = this.plotWidth
    ctx.save()
    ctx.beginPath()
    ctx.rect(GUTTER, y, pw, h)
    ctx.clip()
    for (const p of progs) {
      const l = this.xOf(p.start)
      const r = this.xOf(p.end)
      if (r < GUTTER || l > GUTTER + pw) continue
      ctx.fillStyle = th.grid
      ctx.fillRect(l, y + 4, Math.max(1, r - l), h - 8)
      const cl = Math.max(l, GUTTER) + 4
      const cr = Math.min(r, GUTTER + pw) - 4
      if (cr - cl > 30) {
        ctx.fillStyle = th.inkSecondary
        this.text(ctx, p.name, cl, y + h / 2, cr - cl)
      }
    }
    ctx.restore()
  }

  private notRecorded(ctx: CanvasRenderingContext2D, y: number, h: number): void {
    const th = this.theme
    ctx.save()
    ctx.beginPath()
    ctx.rect(GUTTER, y, this.plotWidth, h - 1)
    ctx.clip()
    ctx.strokeStyle = th.grid
    ctx.lineWidth = 1
    ctx.beginPath()
    for (let x = GUTTER - h; x < GUTTER + this.plotWidth; x += 8) {
      ctx.moveTo(x, y + h)
      ctx.lineTo(x + h, y)
    }
    ctx.stroke()
    ctx.fillStyle = th.inkMuted
    ctx.fillText('not recorded', GUTTER + 8, y + h / 2)
    ctx.restore()
  }

  /** Grey the time outside the window of a windowed dump. */
  private drawWindowShade(ctx: CanvasRenderingContext2D): void {
    const w = this.rec.window
    if (!w) return
    ctx.fillStyle = this.theme.page
    ctx.globalAlpha = 0.7
    const l = this.xOf(w[0])
    const r = this.xOf(w[1])
    if (l > GUTTER) ctx.fillRect(GUTTER, AXIS, l - GUTTER, this.height - AXIS)
    if (r < this.width) ctx.fillRect(r, AXIS, this.width - r, this.height - AXIS)
    ctx.globalAlpha = 1
  }

  private triangle(ctx: CanvasRenderingContext2D, x: number, y: number, open: boolean): void {
    ctx.beginPath()
    if (open) {
      ctx.moveTo(x - 4, y - 2)
      ctx.lineTo(x + 4, y - 2)
      ctx.lineTo(x, y + 3)
    } else {
      ctx.moveTo(x - 2, y - 4)
      ctx.lineTo(x + 3, y)
      ctx.lineTo(x - 2, y + 4)
    }
    ctx.closePath()
    ctx.fill()
  }

  private text(ctx: CanvasRenderingContext2D, s: string, x: number, y: number, maxWidth: number): void {
    if (maxWidth <= 0) return
    if (ctx.measureText(s).width <= maxWidth) {
      ctx.fillText(s, x, y)
      return
    }
    let lo = 0
    let hi = s.length
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (ctx.measureText(`${s.slice(0, mid)}…`).width <= maxWidth) lo = mid
      else hi = mid - 1
    }
    if (lo > 0) ctx.fillText(`${s.slice(0, lo)}…`, x, y)
  }

  // ---- tooltips -------------------------------------------------------------------------

  // ---- reverse attribution (views-design 7.1) -----------------------------------------------

  /** The usage the view asks for: the selected tasks (sorted), or null. */
  private usageQuery(): { key: string; req: UsageRequest; tasks: number[] } | null {
    if (!this.showUsage || this.selectedTasks.size === 0) return null
    const charges = this.trace.reader.files.get('charges.parquet')
    if (!charges) return null
    const tasks = [...this.selectedTasks].sort((x, y) => x - y)
    const c = this.trace.facts.tasks.cols
    const num = (col: string, t: number) => { const v = (c[col] as Float64Array | undefined)?.[t]; return v !== undefined && v === v ? v : null }
    const req: UsageRequest = {
      charges,
      blocks: this.trace.manifest.charge_blocks.map((b) => ({ t0: b.t0, t1: b.t1, maxEnd: b.max_end })),
      tasks: tasks.map((t) => {
        const call = num('call', t)
        const invoke = num('invoke', t) ?? 0
        return { gid: (c.gid as Int32Array)[t], a: Math.min(invoke, call ?? invoke),
          b: num('retire', t) ?? num('complete', t) ?? this.endTime }
      }),
      ceiling: this.usageCaps.ceiling, classBase: this.trace.classBase,
    }
    return { key: tasks.join(','), req, tasks }
  }

  /** Starts the usage query when the selection changed (the latest wins). */
  private requestUsage(): void {
    const q = this.usageQuery()
    if (!q) { this.usage = null; this.usageAsked = ''; return }
    if (q.key === this.usageAsked) return
    this.usageAsked = q.key
    void this.pool.compute<Usage>({ op: 'taskUsage', req: q.req }, [], ATTRIBUTION_WORKER).then((res) => {
      if (this.usageAsked !== q.key) return
      const byRes = new Map<number, [number, number]>()
      for (let i = 0; i < res.resource.length;) {
        let j = i
        while (j < res.resource.length && res.resource[j] === res.resource[i]) j++
        byRes.set(res.resource[i], [i, j])
        i = j
      }
      this.usage = { key: q.key, tasks: q.tasks, res, byRes }
      this.usageTotals.clear()
      this.onUsage?.()
    })
  }

  /** Per selected task, the fraction of the row's resource it holds in each of the n pixels
   * of the view (the average over the pixel; a fabric row: the largest member fraction);
   * null if the row has none. */
  usagePixels(row: Row, n: number): Float64Array[] | null {
    const u = this.usage
    if (!u || !this.showUsage || (row.kind !== 'resource' && row.kind !== 'fabric')) return null
    const members = row.kind === 'fabric' ? this.source.fabrics[row.id].members : [row.id]
    const { t0, cpp } = this.view
    const { task, start, end, frac } = u.res
    let out: Float64Array[] | null = null
    const tmp = new Float64Array(n)
    for (const r of members) {
      const span = u.byRes.get(r)
      if (!span || (!this.controlTraffic && this.isControl(r))) continue
      out ??= u.tasks.map(() => new Float64Array(n))
      for (let i = span[0]; i < span[1];) {
        const k = task[i]
        tmp.fill(0)
        for (; i < span[1] && task[i] === k; i++) {
          const f = frac[i]
          if (!(f > 0)) continue
          const x0 = Math.max(0, (start[i] - t0) / cpp)
          const x1 = Math.min(n, (end[i] - t0) / cpp)
          if (x1 <= x0) continue
          const p0 = Math.floor(x0)
          const p1 = Math.floor(x1)
          if (p0 === p1) { tmp[p0] += f * (x1 - x0); continue }
          tmp[p0] += f * (p0 + 1 - x0)
          for (let p = p0 + 1; p < p1; p++) tmp[p] += f
          if (p1 < n) tmp[p1] += f * (x1 - p1)
        }
        const acc = out[k]
        for (let p = 0; p < n; p++) if (tmp[p] > acc[p]) acc[p] = tmp[p]
      }
    }
    return out
  }

  /** The row that shows a resource: its own row, else the innermost fabric or memory node
   * row that holds it (a closed node takes the arrows of its members); -1 if none. */
  private resourceRows(): Map<number, number> {
    const out = new Map<number, number>()
    this.model.rows.forEach((row, i) => {
      if (row.kind === 'fabric') for (const r of this.source.fabrics[row.id].members) out.set(r, i)
    })
    this.model.rows.forEach((row, i) => { if (row.kind === 'resource') out.set(row.id, i) })
    return out
  }

  /** The usage arrows (views-design 7.1): per selected task and resource row it charged
   * (a closed fabric or memory node: its members together), from the task's bar to the row
   * at its peak charge there, labelled with the task's peak band height on the row (the
   * largest amount / (ceiling x span) of its charges; a node: over its members). The hover
   * tooltip adds its amount, its share of the row over its lifetime [min(call, invoke),
   * retire) and the peak lanes held. The largest peaks first. Cached per usage and row
   * model once exact. */
  usageArrows(): UsageArrow[] {
    const u = this.usage
    if (!u || !this.showUsage) return []
    const cached = this.arrowCache
    if (cached && cached.usage === u && cached.model === this.model && cached.control === this.controlTraffic) return cached.arrows
    const arrows = this.computeUsageArrows(u)
    if (arrows.every((a) => a.exact)) this.arrowCache = { usage: u, model: this.model, control: this.controlTraffic, arrows }
    return arrows
  }

  private computeUsageArrows(u: NonNullable<typeof this.usage>): UsageArrow[] {
    const rows = this.resourceRows()
    const c = this.trace.facts.tasks.cols
    const { task, resource, start, end, amount } = u.res
    // per (task, row): the task's amount, its resources, its largest charge
    const resDims = this.trace.dims.resources
    const acc = new Map<string, { k: number; row: number; amount: number; byUnit: Map<string, number>; res: Set<number>; peak: number;
      peakLanes: number; lanes: number }>()
    for (let i = 0; i < task.length; i++) {
      if (!(amount[i] > 0) || (!this.controlTraffic && this.isControl(resource[i]))) continue
      const row = rows.get(resource[i]) ?? -1
      const key = `${task[i]}|${row < 0 ? `r${resource[i]}` : row}`
      let e = acc.get(key)
      if (!e) acc.set(key, (e = { k: task[i], row, amount: 0, byUnit: new Map(), res: new Set(), peak: i, peakLanes: 0, lanes: 0 }))
      e.amount += amount[i]
      if (u.res.frac[i] > u.res.frac[e.peak]) e.peak = i
      const unit = String(resDims[resource[i]]?.unit ?? '')
      e.byUnit.set(unit, (e.byUnit.get(unit) ?? 0) + amount[i])
      e.res.add(resource[i])
      const lanes = (resDims[resource[i]]?.capacity as number | null | undefined) ?? 0
      const span = end[i] - start[i]
      if (lanes > 0 && span > 0 && u.res.cycles[i] / span > e.peakLanes) { e.peakLanes = u.res.cycles[i] / span; e.lanes = lanes }
    }
    const out: UsageArrow[] = []
    for (const e of acc.values()) {
      const t = u.tasks[e.k]
      const num = (col: string) => { const v = (c[col] as Float64Array | undefined)?.[t]; return v !== undefined && v === v ? v : null }
      const invoke = num('invoke') ?? 0
      const a = Math.min(invoke, num('call') ?? invoke)
      const b = num('retire') ?? num('complete') ?? this.endTime
      let total = 0
      let exact = true
      for (const res of e.res) {
        const x = this.resourceAmount(res, a, b)
        total += x.amount
        exact &&= x.exact
      }
      const name = e.row >= 0 ? this.model.rows[e.row].label : String(this.trace.dims.resources[[...e.res][0]]?.name ?? '')
      // the label: one unit, else bytes only
      const [unit, own] = e.byUnit.size === 1 ? [...e.byUnit][0] : ['B', e.byUnit.get('B') ?? 0]
      out.push({ task: t, row: e.row, t: (start[e.peak] + end[e.peak]) / 2, peak: Math.min(1, u.res.frac[e.peak]), amount: own, unit,
        share: total > 0 ? Math.min(1, e.amount / total) : 0, peakLanes: e.lanes > 0 ? e.peakLanes : null,
        lanes: e.lanes > 0 ? e.lanes : null, exact, name, resources: [...e.res], a, b })
    }
    return out.sort((x, y) => y.peak - x.peak || y.share - x.share)
  }

  /** A resource's amount over [a, b), clipped to the recorded window; cached per usage
   * once exact. */
  private resourceAmount(resource: number, a: number, b: number): { amount: number; exact: boolean } {
    const key = `${resource}|${a}|${b}`
    const hit = this.usageTotals.get(key)
    if (hit) return hit
    const avg = this.average(resource, { a, b })
    const part = recordedPart(this.rec.window, a, b)
    const v = { amount: part ? avg.value * (part.b - part.a) : 0, exact: avg.exact }
    if (v.exact) this.usageTotals.set(key, v)
    return v
  }

  /** The usage arrows: dotted, in the task's kind color, from the bar (at the time of the
   * charge, within the bar) to the resource row, an arrowhead and the share there; the edge
   * rule (a hidden row or a bar off the plot: the plot edge, with the name). */
  private drawUsageArrows(ctx: CanvasRenderingContext2D): void {
    this.arrowHits = []
    const all = this.usageArrows()
    if (!all.length) return
    const arrows = all.slice(0, this.maxFlightlines)
    const th = this.theme
    const top = AXIS + 3
    const bottom = this.height - 3
    const colors = [...th.series, th.seriesOther]
    const c = this.trace.facts.tasks.cols
    ctx.save()
    ctx.font = `${th.fontSizeXs}px ${th.fontSans}`
    ctx.textBaseline = 'middle'
    const labels: { x: number; y: number; w: number; text: string; color: string }[] = []
    for (const a of arrows) {
      const color = colors[this.slots[a.task]] ?? th.seriesOther
      // source: the bar at the charge's time (within the bar)
      const iss = (c.issue as Float64Array)[a.task]
      const s0 = iss === iss ? iss : (c.invoke as Float64Array)[a.task]
      const cmp = (c.complete as Float64Array)[a.task]
      const s1 = cmp === cmp ? cmp : this.endTime
      const lri = this.model.rowOfLane[(c.lane as Int32Array)[a.task]]
      let sx = this.xOf(Math.max(s0, Math.min(s1, a.t)))
      let sy = top
      if (lri >= 0) {
        const { pad, subH } = this.laneBox(this.model.rows[lri])
        sy = this.rowTop(lri) + pad + (this.trace.lanes.taskSub[a.task] + 0.5) * subH
      }
      sx = Math.max(GUTTER, Math.min(this.width, sx))
      sy = Math.max(top, Math.min(bottom, sy))
      // target: the resource row at the charge's time
      const shown = a.row >= 0
      const ty0 = shown ? this.rowTop(a.row) + this.model.rows[a.row].height / 2 : top
      const tx = Math.max(GUTTER, Math.min(this.width, this.xOf(a.t)))
      const ty = Math.max(top, Math.min(bottom, ty0))
      ctx.strokeStyle = color
      ctx.fillStyle = color
      ctx.lineWidth = 1.5 + 2.5 * a.peak
      ctx.lineCap = 'round'
      ctx.setLineDash([1, 4])
      ctx.globalAlpha = 0.9
      ctx.beginPath()
      ctx.moveTo(sx, sy)
      const my = (sy + ty) / 2
      ctx.bezierCurveTo(sx, my, tx, my, tx, ty)
      ctx.stroke()
      ctx.setLineDash([])
      // the arrowhead, along the curve's end (vertical)
      const dir = ty >= my ? 1 : -1
      ctx.beginPath()
      ctx.moveTo(tx, ty)
      ctx.lineTo(tx - 4, ty - dir * 7)
      ctx.lineTo(tx + 4, ty - dir * 7)
      ctx.closePath()
      ctx.fill()
      ctx.globalAlpha = 1
      const peakText = pct(a.peak)
      const text = shown && ty === ty0 ? peakText : `${peakText} · ${short(a.name)}`
      const w = ctx.measureText(text).width + 8
      const lx = Math.min(this.width - w - 2, tx + 6)
      if (labels.some((q) => lx < q.x + q.w && q.x < lx + w && Math.abs(q.y - ty) < 14)) continue
      labels.push({ x: lx, y: ty, w, text, color })
      this.arrowHits.push({ x0: lx, x1: lx + w, y0: ty - 8, y1: ty + 8, arrow: a })
    }
    for (const q of labels) {
      ctx.fillStyle = th.surface
      ctx.strokeStyle = q.color
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.roundRect(q.x, q.y - 8, q.w, 16, 8)
      ctx.fill()
      ctx.stroke()
      ctx.fillStyle = th.ink
      ctx.fillText(q.text, q.x + 4, q.y)
    }
    if (all.length > arrows.length) {
      ctx.fillStyle = th.inkSecondary
      ctx.fillText(`+${all.length - arrows.length}`, GUTTER + 6, top + 8)
    }
    ctx.restore()
  }

  /** The selected tasks' shading on a series row: per pixel a band from the baseline up to
   * each task's fraction, stacked in task-kind colors, below the curve (`ys`, row-relative). */
  private drawUsage(ctx: CanvasRenderingContext2D, row: Row, y: number, n: number, base: number, h: number): void {
    const px = this.usagePixels(row, n)
    if (!px) return
    const u = this.usage as NonNullable<typeof this.usage>
    const colors = [...this.theme.series, this.theme.seriesOther]
    const cum = new Float64Array(n)
    ctx.save()
    ctx.globalAlpha = 0.75
    u.tasks.forEach((t, k) => {
      ctx.fillStyle = colors[this.slots[t]] ?? this.theme.seriesOther
      const v = px[k]
      for (let p = 0; p < n; p++) {
        if (!(v[p] > 0)) continue
        const curve = this.ys[p] + 1
        const lo = Math.max(curve, base - Math.min(1.08, cum[p]) * h)
        const hi = Math.max(curve, base - Math.min(1.08, cum[p] + v[p]) * h)
        cum[p] += v[p]
        if (lo - hi > 0.05) ctx.fillRect(GUTTER + p, y + hi, 1, lo - hi)
      }
    })
    ctx.restore()
  }

  // ---- attribution (views-design 7) ------------------------------------------------------

  /** The attribution the view asks for: the selected resource row (a fabric or memory node:
   * all its members) at the cursor, else over the range; null without either. */
  /** A row of control-class resources (a control bus port or link, or a node of them) or a
   * Neutrino scalar row. */
  isControlRow(row: Row): boolean {
    const r = row.kind === 'fabric' ? this.source.fabrics[row.id].members[0] : row.kind === 'resource' ? row.id : -1
    return r >= 0 && this.isControl(r)
  }

  private isControl(resource: number): boolean {
    return this.res[resource]?.cls === 'control' || this.trace.dims.resources[resource]?.role === 'scalar'
  }

  attributionQuery(): { key: string; req: AttributionRequest } | null {
    const row = this.focusRow()
    if (!row || (row.kind !== 'resource' && row.kind !== 'fabric')) return null
    if (!this.controlTraffic && this.isControlRow(row)) return null
    // Over the recorded part of the range (an instant outside the recording: no query).
    const t = this.pinned !== null && recordedAt(this.rec.window, this.pinned) ? this.pinned : null
    const r = t === null && this.pinned === null && this.selection && this.selection.b > this.selection.a
      ? recordedPart(this.rec.window, this.selection.a, this.selection.b) : null
    if (t === null && !r) return null
    const resources = row.kind === 'fabric' ? this.source.fabrics[row.id].members : [row.id]
    const files = this.trace.reader.files
    const charges = files.get('charges.parquet')
    const tasks = files.get('tasks.parquet')
    if (!charges || !tasks || !resources.length) return null
    const key = `${row.key}|${t ?? `${r?.a}-${r?.b}`}`
    return { key, req: { usage: files.get('usage.parquet') ?? null, charges, resources, t,
      a: r?.a ?? 0, b: r?.b ?? 0,
      blocks: this.trace.manifest.charge_blocks.map((b) => ({ t0: b.t0, t1: b.t1, maxEnd: b.max_end })),
      tasks, opcodes: this.trace.dims.opcodes.map((o) => String(o.name)), classBase: this.trace.classBase } }
  }

  /** Starts the query when the selection, cursor or range changed (the latest wins). */
  private requestAttribution(): void {
    const q = this.attributionQuery()
    if (!q) { this.attribution = null; this.attributionAsked = ''; return }
    if (q.key === this.attributionAsked) return
    this.attributionAsked = q.key
    if (this.attribution && this.attribution.key !== q.key) this.attribution = null
    // one worker: its task-kind cache is read once per trace
    void this.pool.compute<Attribution>({ op: 'attribute', req: q.req }, [], ATTRIBUTION_WORKER).then((res) => {
      if (this.attributionAsked !== q.key) return
      this.attribution = { key: q.key, res }
      this.onAttribution?.()
    })
  }

  /** An owner's name: a task's label, a program and its Neutrino, or no owner. */
  ownerName(owner: number): string {
    if (owner === -1) return 'no owner'
    if (owner <= -2) {
      const pc = this.trace.facts.programs.cols
      const i = -2 - owner
      const name = pc.name as { dict: string[]; codes: Int32Array }
      const nu = (pc.nu as Int32Array)[i]
      return `program ${name.dict?.[name.codes?.[i]] ?? i} · ${short(String(this.trace.dims.nodes[nu]?.path ?? nu))}`
    }
    const task = this.taskOfGid(owner)
    return task < 0 ? `gid ${owner} · not in the trace` : taskName(this.trace, task)
  }

  /** The tasks table row of a gid (the table is sorted by gid), or -1. */
  private taskOfGid(gid: number): number {
    const g = this.trace.facts.tasks.cols.gid as Int32Array
    let lo = 0
    let hi = g.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (g[mid] < gid) lo = mid + 1
      else hi = mid
    }
    return lo < g.length && g[lo] === gid ? lo : -1
  }

  /** Where a flightline ends: a task's bar at the time (an instant, or the middle of its
   * overlap with the range) on its lane, a program's bar in its Neutrino's group header;
   * null for no owner. `shown` is false when the lane or group is not drawn (the edge rule
   * of the dependency arrows: the plot edge, with its name). */
  private ownerPoint(owner: number): { x: number; y: number; shown: boolean; name: string } | null {
    if (owner === -1) return null
    const t = this.pinned
    const r = this.selection
    const at = (s: number, e: number) => {
      const ee = e === e ? e : this.endTime
      if (t !== null) return Math.max(s, Math.min(ee, t))
      const a = Math.max(s, r?.a ?? s)
      const b = Math.min(ee, r?.b ?? ee)
      return b > a ? (a + b) / 2 : (s + ee) / 2
    }
    if (owner <= -2) {
      const pc = this.trace.facts.programs.cols
      const i = -2 - owner
      const nu = (pc.nu as Int32Array)[i]
      const x = this.xOf(at((pc.start as Float64Array)[i], (pc.end as Float64Array)[i]))
      const ri = this.model.rows.findIndex((row) => row.kind === 'group' && row.id === nu)
      const name = String(this.trace.dims.nodes[nu]?.path ?? nu)
      if (ri < 0) return { x, y: AXIS + 3, shown: false, name }
      return { x, y: this.rowTop(ri) + this.model.rows[ri].height / 2, shown: true, name }
    }
    const task = this.taskOfGid(owner)
    if (task < 0) return null
    const c = this.trace.facts.tasks.cols
    const iss = (c.issue as Float64Array)[task]
    const x = this.xOf(at(iss === iss ? iss : (c.invoke as Float64Array)[task], (c.complete as Float64Array)[task]))
    const ri = this.model.rowOfLane[(c.lane as Int32Array)[task]]
    if (ri < 0) return { x, y: AXIS + 3, shown: false, name: this.laneName(task) }
    const { pad, subH } = this.laneBox(this.model.rows[ri])
    return { x, y: this.rowTop(ri) + pad + (this.trace.lanes.taskSub[task] + 0.5) * subH, shown: true, name: this.laneName(task) }
  }

  /** The mode attributeTo resolves to for an attribution. */
  attributionMode(res: Attribution): Exclude<AttributeTo, 'auto'> {
    if (this.attributeTo !== 'auto') return this.attributeTo
    if (res.owners.length <= this.maxFlightlines) return 'task'
    return res.laneKind.length <= this.maxFlightlines ? 'laneKind' : 'kind'
  }

  /** What the flightlines and the tooltip show, the largest value first: the owners, or
   * their groups (attributionMode); the first `limit` of `count`. */
  attributionTargets(res: Attribution, limit: number): { targets: AttributionTarget[]; count: number } {
    const mode = this.attributionMode(res)
    if (mode === 'task') {
      const owners = res.owners.subarray(0, limit)
      return { count: res.owners.length, targets: Array.from(owners, (owner, k) => ({ value: res.values[k],
        name: () => this.ownerName(owner), short: '', tasks: owner >= 0 ? 1 : 0, point: () => this.ownerPoint(owner) })) }
    }
    const groups = mode === 'laneKind' ? res.laneKind : res.kind
    return { count: groups.length, targets: groups.slice(0, limit).map((g) => ({ value: g.value,
      name: () => this.groupName(g, mode), short: g.owner === null ? g.kind : '', tasks: g.tasks,
      point: () => this.groupPoint(g) })) }
  }

  /** A group's name: 'dma_w on gpc1.sm0.dma', 'dma_w · 16 lanes', or the owner's name. */
  private groupName(g: OwnerGroup, mode: 'laneKind' | 'kind'): string {
    if (g.owner !== null) return this.ownerName(g.owner)
    if (g.lane < 0) return `${g.kind}`
    if (mode === 'kind') return g.lanes > 1 ? `${g.kind} · ${g.lanes} lanes` : g.kind
    return `${g.kind} on ${short(String(this.trace.dims.lanes[g.lane]?.path ?? g.lane))}`
  }

  /** Where a group's flightline ends: its lane row (a kind group: the lane with the largest
   * value) at the cursor, or the middle of the range; a program or no owner as ownerPoint. */
  private groupPoint(g: OwnerGroup): { x: number; y: number; shown: boolean; name: string } | null {
    if (g.owner !== null) return this.ownerPoint(g.owner)
    if (g.lane < 0) return null
    const t = this.pinned ?? ((this.selection?.a ?? 0) + (this.selection?.b ?? 0)) / 2
    const x = this.xOf(t)
    const name = String(this.trace.dims.lanes[g.lane]?.path ?? g.lane)
    const ri = this.model.rowOfLane[g.lane]
    if (ri < 0) return { x, y: AXIS + 3, shown: false, name }
    return { x, y: this.rowTop(ri) + this.model.rows[ri].height / 2, shown: true, name }
  }

  /** Flightlines from the selected resource row (at the cursor, or from the middle of its
   * range band) to the owners, the largest shares first, at most maxFlightlines ("+M" for
   * the rest): width by share, a label with the lanes held (instant) or the share (range),
   * a ring on the owner (selected tasks have accent outlines). */
  private drawFlightlines(ctx: CanvasRenderingContext2D): void {
    this.requestAttribution()
    const a = this.attribution
    const row = this.focusRow()
    if (!a || !row || a.key !== this.attributionAsked) return
    const ri = this.model.rows.indexOf(row)
    if (ri < 0) return
    const th = this.theme
    const top = AXIS + 3
    const bottom = this.height - 3
    const t = this.pinned
    const r = this.selection
    const srcT = t ?? ((r?.a ?? 0) + (r?.b ?? 0)) / 2
    const sx = Math.max(GUTTER, Math.min(this.width, this.xOf(srcT)))
    const sy = Math.max(top, Math.min(bottom, this.rowTop(ri) + row.height / 2))
    const color = this.lineColorOf(row)
    const { total } = a.res
    const { targets, count } = this.attributionTargets(a.res, this.maxFlightlines)
    const n = targets.length
    ctx.save()
    ctx.font = `${th.fontSizeXs}px ${th.fontSans}`
    ctx.textBaseline = 'middle'
    // Labels: the largest shares first, each only where it meets no earlier label.
    const labels: { x: number; y: number; w: number; text: string }[] = []
    const points = targets.slice(0, n).map((g) => g.point())
    for (let k = 0; k < n; k++) {
      const p = points[k]
      if (!p) continue
      const v = targets[k].value
      const share = total > 0 ? v / total : 0
      const x = Math.max(GUTTER, Math.min(this.width, p.x))
      const y = Math.max(top, Math.min(bottom, p.y))
      const amount = t !== null ? `${num(v)} slots` : pct(share)
      const label = targets[k].short ? `${amount} ${targets[k].short}` : amount
      const text = p.shown && y === p.y ? label : `${label} · ${short(p.name)}`
      const w = ctx.measureText(text).width + 4
      const lx = Math.min(this.width - w - 2, x + 7)
      if (labels.some((q) => lx < q.x + q.w && q.x < lx + w && Math.abs(q.y - y) < 14)) continue
      labels.push({ x: lx, y, w, text })
    }
    for (let k = n - 1; k >= 0; k--) {
      const p = points[k]
      if (!p) continue
      const share = total > 0 ? targets[k].value / total : 0
      const x = Math.max(GUTTER, Math.min(this.width, p.x))
      const y = Math.max(top, Math.min(bottom, p.y))
      ctx.globalAlpha = 0.75
      ctx.strokeStyle = color
      ctx.lineWidth = 1 + 7 * share
      ctx.beginPath()
      ctx.moveTo(sx, sy)
      ctx.bezierCurveTo(sx, (sy + y) / 2, x, (sy + y) / 2, x, y)
      ctx.stroke()
      ctx.globalAlpha = 1
      ctx.lineWidth = 1.5
      ctx.fillStyle = th.surface
      ctx.beginPath()
      ctx.arc(x, y, 4, 0, 2 * Math.PI)
      ctx.fill()
      ctx.stroke()
    }
    for (const q of labels) {
      ctx.fillStyle = th.surface
      ctx.globalAlpha = 0.85
      ctx.fillRect(q.x - 2, q.y - 7, q.w, 14)
      ctx.globalAlpha = 1
      ctx.fillStyle = th.ink
      ctx.fillText(q.text, q.x, q.y)
    }
    if (count > n) {
      const text = `+${count - n}`
      ctx.fillStyle = th.inkSecondary
      ctx.fillText(text, Math.min(this.width - 30, sx + 8), sy - 10)
    }
    ctx.restore()
  }

  /** The owners section of the selected row's tooltip: the top owners or groups with their
   * shares, and lanes held (instant) or task counts (groups). */
  private attributionSection(): TipSection | null {
    const a = this.attribution
    if (!a || a.key !== this.attributionAsked) return this.attributionQuery() ? { kind: 'note', text: 'owners …' } : null
    const { owners, total } = a.res
    const instant = this.pinned !== null
    const mode = this.attributionMode(a.res)
    const { targets, count: n } = this.attributionTargets(a.res, TIP_ITEMS)
    const items: TipItem[] = targets.map((g) => {
      const share = total > 0 ? g.value / total : 0
      const note = instant ? `${num(g.value)} slots` : mode !== 'task' && g.tasks > 1 ? `${count(g.tasks)} tasks` : ''
      return { share, name: g.name(), value: pct(share), note }
    })
    const what = owners.length === 1 ? '1 owner' : `${count(owners.length)} owners`
    return tipList(instant ? 'owners' : 'owners over the range', items, n,
      mode === 'task' ? what : `${what} · ${count(n)} groups`)
  }

  tooltip(): TipContent | null {
    const h = this.hover
    const hit = h && this.arrowHits.find((q) => h.x >= q.x0 && h.x <= q.x1 && h.y >= q.y0 && h.y <= q.y1)
    if (hit) return this.arrowTip(hit.arrow)
    const tip = this.baseTooltip()
    if (!tip || !h || this.model.rows[h.row]?.key !== this.focusKey) return tip
    const row = this.model.rows[h.row]
    if (!this.controlTraffic && this.isControlRow(row)) return { ...tip, sections: [...tip.sections, { kind: 'note', text: 'attribution off' }] }
    const owners = this.attributionSection()
    return owners ? { ...tip, sections: [...tip.sections, owners] } : tip
  }

  private baseTooltip(): TipContent | null {
    const h = this.hover
    if (!h || h.row < 0 || h.x < GUTTER) return null
    const row = this.model.rows[h.row]
    if (row.notRecorded) return { title: row.label, sections: [{ kind: 'note', text: 'not recorded' }] }
    if (row.kind === 'lane') {
      const task = this.hoveredTask()
      return task < 0 ? null : this.taskTip(task)
    }
    if (row.kind === 'group') return this.programTip(row.id, h.t)
    if (row.kind === 'fabric') return this.fabricTip(row, h)
    if (row.kind !== 'resource') return null
    const s = this.sampled.get(h.row)
    const p = Math.floor(h.x - GUTTER)
    if (!s || p < 0 || p >= s.shown.length) return null
    const info = this.res[row.id]
    if (!recordedAt(this.rec.window, h.t)) return { ...this.resourceTitle(row.id), sections: [{ kind: 'note', text: 'not recorded' }] }
    const byRate = info.rate !== null
    const value = (v: number) => rate(v, byRate ? info.ceiling : null, info.unit)
    const share = (v: number) => (info.ceiling ? pct(v / info.ceiling) : undefined)
    const rows: TipRow[] = [{ label: 'cycle', value: cycles(h.t) }]
    if (this.smoothing > 1) {
      rows.push({ label: 'smoothed', value: value(s.shown[p]), extra: share(s.shown[p]) })
      rows.push({ label: 'raw', value: value(s.raw[p]), extra: share(s.raw[p]) })
    } else rows.push({ label: 'load', value: value(s.raw[p]), extra: share(s.raw[p]) })
    if (!byRate && info.ceiling) rows.push({ label: 'peak', value: rate(info.ceiling, null, info.unit) })
    // Zoomed to charges: the slots held at the cycle shown.
    if (info.capacity !== null && this.view.cpp < this.trace.levels.width) {
      const t = Math.round(h.t)
      const g = this.chargeGroups(t, t + 1)
      if (g) rows.push({ label: 'slots held', value: `${num(lanesHeld(g, row.id, t))} of ${num(info.capacity)}` })
    }
    const sections: TipSection[] = [{ kind: 'rows', rows }]
    if (this.selection && this.selection.b > this.selection.a) {
      const avg = this.average(row.id, this.selection)
      const approx = avg.exact ? '' : '≈'
      sections.push({ kind: 'rows', rows: [avg.recorded
        ? { label: 'range average', value: `${approx}${value(avg.value)}`, extra: share(avg.value) }
        : { label: 'range average', value: 'not recorded' }] })
    }
    return { ...this.resourceTitle(row.id), sections }
  }

  /** A resource's title: its name below its node (hbm.port), and the node path. */
  private resourceTitle(r: number): { title: string; path: string } {
    const node = String(this.trace.dims.nodes[this.trace.dims.resources[r].node as number]?.path ?? '')
    const name = this.res[r].name
    return node && name.startsWith(`${node}.`) ? { title: relative(name, node), path: short(node) } : { title: name, path: '' }
  }

  private fabricTip(row: Row, h: Hover): TipContent | null {
    const s = this.sampled.get(h.row)
    const p = Math.floor(h.x - GUTTER)
    if (!s || p < 0 || p >= s.shown.length) return null
    const f = this.source.fabrics[row.id]
    // The title: the node's path below its owner node (atlas.array, clsbus), the owner muted.
    const owner = String(this.trace.dims.nodes[row.node]?.path ?? '')
    const { name, parent } = owner && f.path.startsWith(`${owner}.`) ? { name: relative(f.path, owner), parent: short(owner) } : splitPath(f.path)
    if (!recordedAt(this.rec.window, h.t)) return { title: name, path: parent, sections: [{ kind: 'note', text: 'not recorded' }] }
    const port = s.argmax?.[p] ?? -1
    const rows: TipRow[] = [{ label: 'cycle', value: cycles(h.t) }]
    if (port >= 0) {
      const info = this.res[port]
      rows.push({ label: 'busiest', value: relative(info.name, f.path), extra: pct(s.raw[p]) })
      if (info.ceiling) rows.push({ label: 'load', value: rate(s.raw[p] * info.ceiling, info.ceiling, info.unit) })
      if (this.smoothing > 1) rows.push({ label: 'smoothed', value: pct(s.shown[p]) })
    } else rows.push({ label: 'load', value: '0' })
    const sections: TipSection[] = [{ kind: 'rows', rows }]
    const v = this.rowValue(h.row, row)
    if (this.selection && this.selection.b > this.selection.a && !v.recorded) {
      sections.push({ kind: 'rows', rows: [{ label: 'range busiest', value: 'not recorded' }] })
    } else if (this.selection && this.selection.b > this.selection.a && v.member >= 0) {
      sections.push({ kind: 'rows', rows: [{ label: 'range busiest', value: relative(this.res[v.member].name, f.path),
        extra: `${v.exact ? '' : '≈'}${pct(v.value)}` }] })
    }
    return { title: name, path: parent, sections }
  }

  /** The task's label in the manifest format, or null if it has none. */
  taskName(task: number): string | null {
    return taskLabel(this.trace, task)
  }

  private taskTip(task: number): TipContent {
    const c = this.trace.facts.tasks.cols
    const num_ = (name: string): number | null => {
      const col = c[name]
      if (!col || isDict(col)) return null
      const v = col[task]
      return col instanceof Int32Array ? (v === -1 ? null : v) : v === v ? v : null
    }
    const dur = (a: number | null, b: number | null) => (a === null || b === null ? '–' : `${count(b - a)} cycles`)
    const invoke = num_('invoke')
    const ready = num_('ready')
    const issue = num_('issue')
    const complete = num_('complete')
    const rows: TipRow[] = [
      { label: 'issue', value: issue === null ? '–' : cycles(issue) },
      { label: 'wait', value: dur(invoke, ready) },
      { label: 'queue', value: dur(ready, issue) },
      { label: 'exec', value: complete === null ? '–' : dur(issue, complete) },
    ]
    const retire = num_('retire')
    if (retire !== null && complete !== null && retire > complete) rows.push({ label: 'retire', value: `+${count(retire - complete)} cycles` })
    const consumers = this.deps.consumers(task, this.pool)
    const links: TipRow[] = [
      { label: 'producers', value: String(this.deps.producers(task).length) },
      { label: 'consumers', value: consumers ? String(consumers.length) : '…' },
    ]
    const chunks = num_('n_chunks')
    if (chunks !== null && chunks > 1) links.push({ label: 'chunks', value: String(chunks) })
    // The Neutrino that tracks the task, when it is not the one of the lane.
    const lanePath = String(this.trace.dims.lanes[(c.lane as Int32Array)[task]]?.path ?? '')
    const nu = String(this.trace.dims.nodes[num_('nu') ?? -1]?.path ?? '')
    if (nu && !lanePath.startsWith(`${nu}.`)) links.push({ label: 'tracked by', value: short(nu) })
    const version = num_('version')
    const name = taskName(this.trace, task)
    const sub = [`gid ${num_('gid')}`]
    if (version !== null && !name.endsWith(` v${version}`)) sub.push(`v${version}`)
    if ((c.untracked as Uint8Array | undefined)?.[task] === 1) sub.push('untracked')
    return { title: name, sub: sub.join(' · '), sections: [{ kind: 'rows', rows }, { kind: 'rows', rows: links }] }
  }

  /** A usage arrow's label: the task, the row, its peak, its amount, its share over its
   * lifetime and the peak lanes it held. */
  private arrowTip(a: UsageArrow): TipContent {
    const rows: TipRow[] = [{ label: 'peak', value: pct(a.peak) }, { label: 'amount', value: formatAmount(a.amount, a.unit) },
      { label: 'share over its life', value: `${a.exact ? '' : '≈'}${pct(a.share)}` }]
    if (a.peakLanes !== null && a.lanes !== null) rows.push({ label: 'slots held', value: `${num(a.peakLanes)} of ${num(a.lanes)}` })
    return { title: taskName(this.trace, a.task), path: short(a.name), sections: [{ kind: 'rows', rows }] }
  }

  /** A program bar in a group header: its name, start, duration and spawning task. */
  private programTip(node: number, t: number): TipContent | null {
    const p = this.programsOf.get(node)?.find((s) => s.start <= t && t < s.end)
    if (!p) return null
    const rows: TipRow[] = [{ label: 'start', value: cycles(p.start) }, { label: 'duration', value: `${count(p.end - p.start)} cycles` }]
    const spawn = p.spawn >= 0 ? this.taskOfGid(p.spawn) : -1
    if (spawn >= 0) rows.push({ label: 'spawned by', value: taskLabel(this.trace, spawn) === null ? `gid ${p.spawn}` : taskName(this.trace, spawn) })
    return { title: p.name || 'program', path: short(String(this.trace.dims.nodes[node]?.path ?? '')), sections: [{ kind: 'rows', rows }] }
  }
}
