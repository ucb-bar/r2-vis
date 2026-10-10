// The timeline renderer: one canvas, the visible rows only. Layout: label gutter on the
// left, time axis on top, rows below (group headers, task lanes, utilization lines).
// The renderer holds the view state; Timeline.tsx turns input into calls on it.
import type { ChargeCache, ChargeGroup } from '../data/charges'
import { isDict } from '../data/columns'
import { taskLabel } from '../data/labels'
import { programSpans } from '../data/programs'
import type { WorkerPool } from '../data/pool'
import type { Trace } from '../data/trace'
import type { BlockSelection } from '../state/blocks'
import { DEFAULT_PREFS, type ViewPrefs } from '../state/viewprefs'
import type { Theme } from '../theme/theme'
import { lineSlots, taskSlots, type LegendEntry } from './colors'
import { ArrowBatch, DepIndex, type ArrowStyle } from './deps'
import { drawLane, taskAt, wideTasks, type ChunkIndex } from './lanes'
import { blend, LaneRaster, pack, rgba, RowRaster, type RowColors, type SlotColors } from './raster'
import { MAX_ROW_HEIGHT, MIN_ROW_HEIGHT, recorded, rowAt, RowSource, type Recorded, type Row, type RowModel } from './rows'
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
  /** link lanes of the resource (resources.lanes; 1 for a v1.0 trace), null if unlimited */
  linkLanes: number | null
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
  private readonly programsOf: Map<number, { start: number; end: number; name: string }[]>
  /** Called after a change of the persisted view state, and after a view change. */
  onPrefs: (() => void) | null = null

  constructor(trace: Trace, charges: ChargeCache, pool: WorkerPool, blocks: BlockSelection,
    theme: Theme, prefs: ViewPrefs) {
    this.axis = new TimeAxis(trace.manifest.end_time)
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
      linkLanes: (r.lanes as number | null | undefined) ?? (r.rate === null ? null : 1),
      levelRow: trace.levels.rowOf[r.id as number] ?? -1,
    }))
    this.collapsed = this.source.initialCollapsed()
    this.applyPrefs(prefs, false)
    this.model = this.build()
    this.focusKey = this.busiestCompute()
    this.programsOf = programSpans(trace)
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
    for (const r of this.source.ownRowsOf(node)) {
      if (this.hidden.has(r.key)) out.push({ key: r.key, label: r.label })
      if (r.kind === 'fabric') {
        for (const m of this.source.fabrics[r.id].members_rows) {
          if (this.hidden.has(m.key)) out.push({ key: m.key, label: `${r.label} › ${m.label}` })
        }
      }
    }
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
    // Left label: the instant value with the cursor on the plot, else an average.
    const v = this.rowValue(index, row)
    const pct = v.scale > 0 ? (100 * v.value) / v.scale : NaN
    const mark = v.marked ? (v.exact ? 'avg ' : 'avg ≈') : ''
    const text = pct === pct ? `${mark}${pct.toFixed(pct >= 99.95 ? 0 : 1)} %` : '–'
    ctx.textAlign = 'right'
    ctx.fillStyle = v.marked ? th.inkMuted : th.ink
    ctx.fillText(text, GUTTER - 10, y + row.height / 2)
    ctx.textAlign = 'left'
  }

  /** Value of a series row for its label: instant (smoothed) at the cursor, else the
   * average over the selection, else over the window. A fabric row gives the busiest
   * port: the largest average fraction of ceiling. */
  rowValue(index: number, row: Row): RowValue {
    const s = this.sampled.get(index)
    const scale = row.kind === 'fabric' ? 1 : this.res[row.id].ceiling ?? 0
    if (s && this.hover && this.hover.x >= GUTTER && !this.zoomBox) {
      const p = Math.floor(this.hover.x - GUTTER)
      if (p >= 0 && p < s.shown.length) {
        return { value: s.shown[p], scale, marked: false, exact: true, member: s.argmax?.[p] ?? -1 }
      }
    }
    const r = this.activeRange()
    if (row.kind === 'fabric') {
      let best = 0
      let member = -1
      let exact = true
      for (const res of this.source.fabrics[row.id].members) {
        const c = this.res[res].ceiling
        if (!c) continue
        const avg = this.average(res, r)
        exact &&= avg.exact
        if (avg.value / c >= best) { best = avg.value / c; member = res }
      }
      return { value: best, scale, marked: true, exact, member }
    }
    const avg = this.average(row.id, r)
    return { value: avg.value, scale, marked: true, exact: avg.exact, member: -1 }
  }

  /** The selection, else the visible window clipped to the run. */
  activeRange(): Range {
    return this.selection && this.selection.b > this.selection.a ? this.selection
      : { a: Math.max(0, this.view.t0), b: Math.min(this.endTime, this.view.t0 + this.plotWidth * this.view.cpp) }
  }

  /** Average throughput of a resource over [a, b) (units per cycle). Exact from the bins
   * and, at partial bins, from the charges when they are loaded. */
  average(resource: number, r: Range): { value: number; exact: boolean } {
    const info = this.res[resource]
    const span = r.b - r.a
    if (span <= 0 || info.levelRow < 0) return { value: 0, exact: true }
    const edge = (x: number, y: number): number | null => {
      const g = this.chargeGroups(x, y)
      return g ? chargesAmount(g, resource, x, y) : null
    }
    const { amount, exact } = rangeAmount(this.trace.levels, info.levelRow, r.a, r.b, edge)
    return { value: amount / span, exact }
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
    return String(this.trace.dims.lanes[lane]?.path ?? '')
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
      ctx.fillText('zoom in to show dependencies', GUTTER + 8, AXIS + 10)
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

  tooltip(): string[] | null {
    const h = this.hover
    if (!h || h.row < 0 || h.x < GUTTER) return null
    const row = this.model.rows[h.row]
    if (row.notRecorded) return [row.label, 'not recorded in this dump']
    if (row.kind === 'lane') {
      const task = this.hoveredTask()
      return task < 0 ? null : this.taskLines(task)
    }
    if (row.kind === 'fabric') return this.fabricLines(row, h)
    if (row.kind !== 'resource') return null
    const s = this.sampled.get(h.row)
    const p = Math.floor(h.x - GUTTER)
    if (!s || p < 0 || p >= s.shown.length) return null
    const info = this.res[row.id]
    const unit = `${info.unit}/cycle`
    const pct = (v: number) => (info.ceiling ? ` · ${((100 * v) / info.ceiling).toFixed(1)} %` : '')
    const lines = [info.name, `t = ${Math.round(h.t).toLocaleString('en-US')} cycles`]
    if (this.smoothing > 1) {
      lines.push(`${fmt(s.shown[p])} ${unit}${pct(s.shown[p])} (smoothed over ${this.smoothing} px)`)
      lines.push(`raw ${fmt(s.raw[p])} ${unit}${pct(s.raw[p])}`)
    } else lines.push(`${fmt(s.raw[p])} ${unit}${pct(s.raw[p])}`)
    if (info.ceiling) {
      lines.push(`100 % = ${fmt(info.ceiling)} ${unit} (${info.rate === null ? 'peak of the run' : 'rate'})`)
    }
    // Zoomed to charges: the link lanes held at the cursor cycle (trace v1.1).
    if (info.linkLanes !== null && this.view.cpp < this.trace.levels.width) {
      const t = Math.round(h.t)   // the cycle printed as t above
      const g = this.chargeGroups(t, t + 1)
      if (g) {
        const held = lanesHeld(g, row.id, t)
        const k = Math.abs(held - Math.round(held)) < 1e-9 ? String(Math.round(held)) : held.toFixed(2)
        lines.push(`link lanes held ${k} of ${info.linkLanes}`)
      }
    }
    if (this.selection && this.selection.b > this.selection.a) {
      const avg = this.average(row.id, this.selection)
      lines.push(`selection avg ${avg.exact ? '' : '≈'}${fmt(avg.value)} ${unit}${pct(avg.value)}`)
    }
    lines.push(`${info.cls} · ${fmt(this.view.cpp)} cycles per px (${this.view.cpp < this.trace.levels.width ? 'charges' : 'bins'})`)
    return lines
  }

  private fabricLines(row: Row, h: Hover): string[] | null {
    const s = this.sampled.get(h.row)
    const p = Math.floor(h.x - GUTTER)
    if (!s || p < 0 || p >= s.shown.length) return null
    const f = this.source.fabrics[row.id]
    const port = s.argmax?.[p] ?? -1
    const lines = [`${f.path} (${f.kind}: ${f.members.length} ${f.kind === 'bus' ? 'ports' : 'directions'})`,
      `t = ${Math.round(h.t).toLocaleString('en-US')} cycles`]
    const pct = (v: number) => `${(100 * v).toFixed(1)} %`
    if (port >= 0) {
      const info = this.res[port]
      lines.push(`max ${pct(s.raw[p])} of ceiling: ${info.name}` + (this.smoothing > 1 ? ` (smoothed max ${pct(s.shown[p])})` : ''))
      if (info.ceiling) lines.push(`${fmt(s.raw[p] * info.ceiling)} ${info.unit}/cycle of ${fmt(info.ceiling)} ${info.unit}/cycle`)
    } else lines.push('no charge')
    const v = this.rowValue(h.row, row)
    if (this.selection && this.selection.b > this.selection.a && v.member >= 0) {
      lines.push(`selection: busiest ${this.res[v.member].name}, avg ${v.exact ? '' : '≈'}${pct(v.value)}`)
    }
    lines.push(`${this.res[f.members[0]].cls} · ${fmt(this.view.cpp)} cycles per px`)
    return lines
  }

  /** The task's label in the manifest format, or null if it has none. */
  taskName(task: number): string | null {
    return taskLabel(this.trace, task)
  }

  private taskLines(task: number): string[] {
    const c = this.trace.facts.tasks.cols
    const num = (name: string): number | null => {
      const col = c[name]
      if (!col || isDict(col)) return null
      const v = col[task]
      return col instanceof Int32Array ? (v === -1 ? null : v) : v === v ? v : null
    }
    const time = (name: string) => {
      const v = num(name)
      return v === null ? '–' : v.toLocaleString('en-US')
    }
    const opcode = this.trace.dims.opcodes[num('opcode') ?? 0]?.name
    const nu = this.trace.dims.nodes[num('nu') ?? 0]?.path
    const version = num('version')
    const issue = num('issue')
    const complete = num('complete')
    const lines = [this.taskName(task) ?? `${opcode} (no label)`,
      `gid ${num('gid')} · ${opcode} · ${nu}${version !== null ? ` · version ${version}` : ''}`,
      `invoke ${time('invoke')} · ready ${time('ready')}`,
      `issue ${time('issue')} · complete ${time('complete')} · retire ${time('retire')}`]
    if (issue !== null && complete !== null) {
      lines.push(`exec ${(complete - issue).toLocaleString('en-US')} cycles · ${num('n_chunks')} chunks · ${num('n_deps')} deps`)
    }
    const lane = (c.lane as Int32Array)[task]
    const depth = this.trace.lanes.depth[lane]
    if (depth > 1) lines.push(`lane ${this.laneName(task)}: up to ${depth} tasks at once (sub-row ${this.trace.lanes.taskSub[task] + 1})`)
    const consumers = this.deps.consumers(task, this.pool)
    lines.push(`${this.deps.producers(task).length} producers · ${consumers ? consumers.length : '…'} consumers` +
      (this.arrowsFor(task) ? '' : ' (zoom in for arrows, or click to select)'))
    return lines
  }
}


function fmt(v: number): string {
  const a = Math.abs(v)
  if (a >= 1e6) return `${(v / 1e6).toFixed(2)} M`
  if (a >= 1e3) return `${(v / 1e3).toFixed(2)} k`
  if (a >= 100) return v.toFixed(0)
  if (a >= 10) return v.toFixed(1)
  return v.toFixed(2)
}
