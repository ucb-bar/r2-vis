import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import type { WorkerPool } from '../data/pool'
import type { Trace } from '../data/trace'
import type { ViewStore } from '../state/viewstore'
import { onThemeChange, readTheme, type Theme } from '../theme/theme'
import { rgba } from '../timeline/raster'
import { Sidebar } from '../ui/Sidebar'
import { useThemeVersion } from '../ui/ThemeToggle'
import { tipPlace, Tooltip, tipList, type TipContent } from '../ui/Tooltip'
import { cycles, num, pct, span, splitPath } from '../ui/format'
import { ControlIndex } from './index'
import { NodePanel } from './NodePanel'
import { ControlData, TABLES, type Metric, type Statistic } from './pressure'
import { NeutrinoTree, type TreeNode } from './tree'

interface Props {
  trace: Trace
  store: ViewStore
  pool: WorkerPool
}

declare global {
  interface Window { __r2control?: ControlIndex; __r2controlData?: ControlData; __r2tree?: NeutrinoTree; __r2controlDraw?: { ms: number[] } }
}

const METRICS: { value: string; label: string; metric: Metric }[] = [
  { value: 'worst:all', label: 'worst of all tables', metric: { kind: 'worst', group: 'all' } },
  { value: 'average:all', label: 'average of all tables', metric: { kind: 'average', group: 'all' } },
  { value: 'worst:lifetime', label: 'worst of the task lifetime tables', metric: { kind: 'worst', group: 'lifetime' } },
  { value: 'average:lifetime', label: 'average of the task lifetime tables', metric: { kind: 'average', group: 'lifetime' } },
  { value: 'worst:remote', label: 'worst of the remote protocol tables', metric: { kind: 'worst', group: 'remote' } },
  { value: 'average:remote', label: 'average of the remote protocol tables', metric: { kind: 'average', group: 'remote' } },
  ...TABLES.map((t) => ({ value: `t:${t.id}`, label: t.name, metric: { kind: 'table', table: t.id } as Metric })),
]
const STATS: { value: Statistic; label: string }[] = [
  { value: 'at', label: 'at the cursor' }, { value: 'average', label: 'range average' }, { value: 'peak', label: 'range peak' },
]

/** The index and the occupancy data of a trace, shared by the control views of all
 * areas (they depend on the trace only). */
const shared = new WeakMap<Trace, { index: ControlIndex; data: ControlData; load: Promise<void> | null }>()

function controlOf(trace: Trace) {
  let s = shared.get(trace)
  if (!s) {
    s = { index: new ControlIndex(trace), data: new ControlData(trace), load: null }
    shared.set(trace, s)
  }
  return s
}

/** Builds the shared index and data of a trace ahead of the first control view. A failed
 * load (a served trace whose server stopped) is reported and tried again by the next view. */
export function prepareControl(trace: Trace, pool: WorkerPool): void {
  const s = controlOf(trace)
  s.load ??= s.data.load(pool).catch((err) => {
    s.load = null
    console.warn(`control data: ${(err as Error).message ?? err}`)
  })
}

/** The control instant view (views-design 6.3): the Neutrinos as a force-directed tree,
 * each filled by the pressure (occupancy / capacity) of a selected metric; a click selects
 * a Neutrino and the sidebar lists its tables and their items. */
export function ControlView({ trace, store, pool }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const index = useMemo(() => controlOf(trace).index, [trace])
  const data = useMemo(() => controlOf(trace).data, [trace])
  const tree = useMemo(() => new NeutrinoTree(trace), [trace])
  const [ready, setReady] = useState(false)
  const [metricKey, setMetricKey] = useState('worst:all')
  const [stat, setStat] = useState<Statistic>('at')
  const [selected, setSelected] = useState<number | null>(null)
  const [time, setTime] = useState<{ t: number } | null>(instantOf(store))
  const [range, setRange] = useState(() => rangeOf(store, trace))
  const [tip, setTip] = useState<{ x: number; y: number; content: TipContent } | null>(null)
  const state = useRef({ metric: METRICS[0].metric, stat: 'at' as Statistic, selected: null as number | null, t: 0, range })
  const redraw = useRef<() => void>(() => {})

  const metric = METRICS.find((m) => m.value === metricKey)?.metric ?? METRICS[0].metric
  const t = time?.t ?? range.a
  // The sidebar's lists follow the cursor at a lower priority than the tree.
  const panelT = useDeferredValue(t)
  state.current = { metric, stat, selected, t, range }
  useEffect(() => { redraw.current() })

  useEffect(() => {
    window.__r2control = index
    window.__r2controlData = data
    window.__r2tree = tree
    let alive = true
    prepareControl(trace, pool)
    controlOf(trace).load?.then(() => { if (alive) setReady(true) })
    let frame = 0
    let next = instantOf(store)
    const offs = [
      // The focus instant, else the range's start (views-design 7).
      store.onTime(() => {
        next = instantOf(store)
        setRange(rangeOf(store, trace))
        if (!frame) frame = requestAnimationFrame(() => { frame = 0; setTime(next) })
      }),
      store.window.subscribe(() => { if (!store.time) setRange(rangeOf(store, trace)) }),
    ]
    return () => { alive = false; offs.forEach((off) => off()); if (frame) cancelAnimationFrame(frame); tree.stop() }
  }, [store, trace, data, index, tree, pool])

  useEffect(() => {
    const el = host.current as HTMLDivElement
    const cv = canvas.current as HTMLCanvasElement
    const ctx = cv.getContext('2d', { alpha: false }) as CanvasRenderingContext2D
    let theme = readTheme()
    let dpr = window.devicePixelRatio || 1
    let w = 1
    let h = 1
    let frame = 0
    let hovered: TreeNode | null = null
    const stats = { ms: [] as number[] }
    window.__r2controlDraw = stats
    // Layout units -> CSS px: fit the tree's bounding box (computed once, kept while dragging).
    let fit = { s: 1, ox: 0, oy: 0 }
    const refit = () => {
      const xs = tree.nodes.map((n) => n.x)
      const ys = tree.nodes.map((n) => n.y)
      const pad = 40
      const bw = Math.max(1, Math.max(...xs) - Math.min(...xs))
      const bh = Math.max(1, Math.max(...ys) - Math.min(...ys))
      const s = Math.min((w - 2 * pad) / bw, (h - 2 * pad) / bh, 2)
      fit = { s, ox: w / 2 - s * (Math.min(...xs) + bw / 2), oy: h / 2 - s * (Math.min(...ys) + bh / 2) }
    }
    const X = (x: number) => fit.ox + fit.s * x
    const Y = (y: number) => fit.oy + fit.s * y
    const r = () => Math.max(5, Math.min(16, tree.radius * fit.s))
    const draw = () => {
      frame = 0
      const t0 = performance.now()
      const { metric: m, stat: st, selected: sel, t: tt, range: rg } = state.current
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.fillStyle = theme.surface
      ctx.fillRect(0, 0, w, h)
      ctx.strokeStyle = theme.axis
      ctx.lineWidth = 1
      ctx.beginPath()
      for (const l of tree.links) {
        ctx.moveTo(X(l.source.x), Y(l.source.y))
        ctx.lineTo(X(l.target.x), Y(l.target.y))
      }
      ctx.stroke()
      const rad = r()
      ctx.font = `${theme.fontSizeXs}px ${theme.fontSans}`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'top'
      for (const n of tree.nodes) {
        const v = data.ready ? data.heat(n.id, m, st, tt, rg.a, rg.b) : null
        const x = X(n.x)
        const y = Y(n.y)
        ctx.beginPath()
        ctx.arc(x, y, rad, 0, 2 * Math.PI)
        ctx.fillStyle = v === null ? theme.grid : heatColor(theme, v)
        ctx.fill()
        ctx.lineWidth = n.id === sel ? 3 : n === hovered ? 2 : 1
        ctx.strokeStyle = n.id === sel ? theme.accent : n === hovered ? theme.ink : theme.axis
        if (v === null) ctx.setLineDash([2, 2])
        ctx.stroke()
        ctx.setLineDash([])
        if (n.depth <= 1 || rad >= 10) {
          ctx.fillStyle = theme.inkSecondary
          ctx.fillText(n.name, x, y + rad + 2)
        }
      }
      stats.ms.push(performance.now() - t0)
      if (stats.ms.length > 2000) stats.ms.splice(0, 1000)
    }
    const request = () => { if (!frame) frame = requestAnimationFrame(draw) }
    redraw.current = request
    const resize = () => {
      if (el.clientWidth === 0 || el.clientHeight === 0) return
      dpr = window.devicePixelRatio || 1
      w = el.clientWidth
      h = el.clientHeight
      cv.width = Math.round(w * dpr)
      cv.height = Math.round(h * dpr)
      cv.style.width = `${w}px`
      cv.style.height = `${h}px`
      refit()
      request()
    }
    const ro = new ResizeObserver(resize)
    ro.observe(el)
    resize()
    const offTheme = onThemeChange(() => { theme = readTheme(); request() })
    const pos = (e: MouseEvent) => {
      const b = cv.getBoundingClientRect()
      return { x: e.clientX - b.left, y: e.clientY - b.top }
    }
    const nodeAt = (x: number, y: number): TreeNode | null => {
      let best: TreeNode | null = null
      let bestD = r() + 3
      for (const n of tree.nodes) {
        const d = Math.hypot(X(n.x) - x, Y(n.y) - y)
        if (d < bestD) { best = n; bestD = d }
      }
      return best
    }
    let drag: { node: TreeNode; x0: number; y0: number; moved: boolean } | null = null
    const onDown = (e: PointerEvent) => {
      const { x, y } = pos(e)
      const n = nodeAt(x, y)
      if (!n || e.button !== 0) return
      drag = { node: n, x0: x, y0: y, moved: false }
      cv.setPointerCapture(e.pointerId)
    }
    const onMove = (e: PointerEvent) => {
      const { x, y } = pos(e)
      if (drag) {
        if (!drag.moved && Math.hypot(x - drag.x0, y - drag.y0) <= 3) return
        drag.moved = true
        tree.drag(drag.node, (x - fit.ox) / fit.s, (y - fit.oy) / fit.s, request)
        setTip(null)
        return
      }
      const n = nodeAt(x, y)
      if (n !== hovered) { hovered = n; request() }
      if (!n) { setTip(null); return }
      const { metric: m, stat: st, t: tt, range: rg } = state.current
      setTip({ x, y, content: nodeTip(n.path, data, n.id, m, st, tt, rg.a, rg.b) })
      cv.style.cursor = 'pointer'
    }
    const onUp = (e: PointerEvent) => {
      const d = drag
      drag = null
      if (!d) return
      if (d.moved) tree.release(d.node)
      else setSelected((s) => (s === d.node.id ? null : d.node.id))
      void e
      request()
    }
    const onLeave = () => { hovered = null; setTip(null); request() }
    // A trackpad pinch (ctrl+wheel) over the tree must not zoom the page.
    const onWheel = (e: WheelEvent) => { if (e.ctrlKey) e.preventDefault() }
    cv.addEventListener('wheel', onWheel, { passive: false })
    cv.addEventListener('pointerdown', onDown)
    cv.addEventListener('pointermove', onMove)
    cv.addEventListener('pointerup', onUp)
    cv.addEventListener('pointercancel', onUp)
    cv.addEventListener('mouseleave', onLeave)
    return () => {
      ro.disconnect()
      offTheme()
      cv.removeEventListener('pointerdown', onDown)
      cv.removeEventListener('pointermove', onMove)
      cv.removeEventListener('pointerup', onUp)
      cv.removeEventListener('pointercancel', onUp)
      cv.removeEventListener('mouseleave', onLeave)
      cv.removeEventListener('wheel', onWheel)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [tree, data])

  useThemeVersion()   // the legend reads the tokens
  const theme = readTheme()
  return (
    <div className="control2">
      <div className="control2-main">
        <div className="control-head">
          <label className="tool">
            fill
            <select value={metricKey} onChange={(e) => setMetricKey(e.target.value)}>
              <optgroup label="aggregates">
                {METRICS.slice(0, 6).map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </optgroup>
              <optgroup label="one table">
                {METRICS.slice(6).map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </optgroup>
            </select>
          </label>
          <select value={stat} onChange={(e) => setStat(e.target.value as Statistic)}>
            {STATS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
          <span className="heat-legend">
            0 %<span className="ramp heat-ramp" style={{ background: `linear-gradient(90deg, ${theme.seq.join(', ')})` }} />100 %
            <span className="swatch heat-none" title="not recorded or no capacity" /> n/a
          </span>
          <span className="spacer" />
          <span className="instant-active" title={stat === 'at' && !time ? 'range start' : undefined}>
            {stat === 'at' ? `t = ${cycles(t)}` : span(range.a, range.b)}
          </span>
          {!ready && <span className="badge">loading</span>}
          {ready && !data.hasEntries && <span className="badge" title="6 of 8 tables not recorded">no entries</span>}
        </div>
        <div className="control-tree" ref={host}>
          <canvas ref={canvas} />
          {tip && <Tooltip tip={tip.content} style={tipPlace(tip, host.current)} />}
        </div>
      </div>
      <Sidebar name="control" width={460}>
        {selected === null
          ? <div className="muted" title="click a Neutrino">no Neutrino selected</div>
          : <NodePanel trace={trace} store={store} data={data} index={index} node={selected} t={panelT} range={range} key={ready ? 1 : 0} />}
      </Sidebar>
    </div>
  )
}

/** The focus instant, or null. */
function instantOf(store: ViewStore): { t: number } | null {
  const t = store.time
  return t && 't' in t ? { t: t.t } : null
}

/** The range for averages and peaks: the focus range, else the window; clipped to the run. */
function rangeOf(store: ViewStore, trace: Trace): { a: number; b: number } {
  const t = store.time
  const r = t && 'a' in t ? t : store.window.get()
  const end = trace.manifest.end_time
  const a = Math.max(0, Math.min(r.a, end - 1))
  return { a, b: Math.max(a + 1, Math.min(r.b, end)) }
}

/** The sequential scale of the theme (seq-0 .. seq-6) at v in [0, 1]. */
function heatColor(th: Theme, v: number): string {
  const steps = th.seq
  const x = Math.max(0, Math.min(1, v)) * (steps.length - 1)
  const i = Math.min(steps.length - 2, Math.floor(x))
  const f = x - i
  const a = rgba(steps[i])
  const b = rgba(steps[i + 1])
  const mix = (k: number) => Math.round(a[k] + (b[k] - a[k]) * f)
  return `rgb(${mix(0)}, ${mix(1)}, ${mix(2)})`
}

/** A node's tooltip: the tables of the metric, the fullest first, with their occupancy. */
function nodeTip(path: string, data: ControlData, node: number, m: Metric, st: Statistic, t: number, a: number, b: number): TipContent {
  const { name, parent } = splitPath(path)
  const tables = data.ready ? data.tablesOf(node, m, st, t, a, b) : []
  if (!tables.length) {
    const why = !data.ready ? 'loading' : data.recordedFor(st, t, a, b) ? 'no table with a capacity' : 'not recorded'
    return { title: name, path: parent, sections: [{ kind: 'note', text: why }] }
  }
  const items = tables.map((x) => ({ share: x.pressure, name: x.name, value: pct(x.pressure), note: `${num(x.value)} / ${x.cap}` }))
  return { title: name, path: parent, sections: [tipList('tables', items, items.length)] }
}
