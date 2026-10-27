import { Tooltip, type TipContent } from '../ui/Tooltip'
import { cycles } from '../ui/format'
import { useEffect, useRef, useState } from 'react'
import type { ChargeCache } from '../data/charges'
import type { Trace } from '../data/trace'
import type { ViewStore } from '../state/viewstore'
import { onThemeChange, readTheme } from '../theme/theme'
import { zoomFactor } from '../timeline/viewport'
import { Section, Sidebar } from '../ui/Sidebar'
import { useAreaState } from '../ui/area'
import { CLASS_ORDER, type LinkClass } from './model'
import { TrafficRenderer, type ClassOptions } from './renderer'

declare global {
  interface Window { __r2traffic?: TrafficRenderer; __r2trafficAnim?: { running: boolean; frames: number } }
}

interface Props {
  trace: Trace
  charges: ChargeCache
  store: ViewStore
}

/** The zoom slider has tick marks only up to this many levels. */
const MAX_TICKS = 8
let ticks = 0

interface Tip {
  x: number
  y: number
  content: TipContent
}

interface Prefs {
  scaleByBandwidth: boolean
  animate: boolean
  classes: Record<LinkClass, ClassOptions>
  channels: 'combined' | 'separate'
}

const PREFS_KEY = 'r2vis.traffic'

function loadClasses(saved: Partial<Record<LinkClass, Partial<ClassOptions>>> | undefined): Record<LinkClass, ClassOptions> {
  return Object.fromEntries(CLASS_ORDER.map((c) => [c, { visible: saved?.[c]?.visible !== false, collapse: saved?.[c]?.collapse !== false }])) as
    Record<LinkClass, ClassOptions>
}

function loadPrefs(): Prefs {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '') as Partial<Prefs>
    return { scaleByBandwidth: p.scaleByBandwidth === true, animate: p.animate !== false, classes: loadClasses(p.classes),
      channels: p.channels === 'separate' ? 'separate' : 'combined' }
  } catch {
    return { scaleByBandwidth: false, animate: true, classes: loadClasses(undefined), channels: 'combined' }
  }
}

function savePrefs(p: Prefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p))
  } catch {
    // storage unavailable: the options are not kept
  }
}

/** The traffic view: the fabric at the active time range of the shared state. Wheel
 * scrolls; alt+wheel or the slider zooms vertically: the zoom picks the finest level (the
 * same merge step for every parent at a depth) whose packed drawing fits in the zoom
 * height. ctrl+wheel (or pinch) zooms horizontally around the pointer, shift+wheel (or a
 * horizontal wheel) scrolls horizontally, and so does the scroll bar under the plot (drag
 * the thumb; drag an end to zoom; double click: fit). Three stacked canvases: the base and
 * the top layer are drawn on a change; only the pattern layer between them is drawn per
 * animation frame. */
export function TrafficView({ trace, charges, store }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const baseCanvas = useRef<HTMLCanvasElement>(null)
  const animCanvas = useRef<HTMLCanvasElement>(null)
  const topCanvas = useRef<HTMLCanvasElement>(null)
  const bar = useRef<HTMLDivElement>(null)
  // The horizontal view, kept per area: the shares of the plot shown.
  const [xv, setXv] = useAreaState<{ start: number; end: number }>('traffic.x', () => ({ start: 0, end: 1 }))
  const [renderer] = useState(() => {
    const r = new TrafficRenderer(trace, charges, readTheme())
    const p = loadPrefs()
    r.scaleByBandwidth = p.scaleByBandwidth
    r.classes = p.classes
    r.channels = p.channels
    r.setXView(xv.start, xv.end)
    return r
  })
  const [plot, setPlot] = useState({ left: 0, width: 0 })
  const [tickId] = useState(() => `traffic-zoom-ticks-${++ticks}`)
  const syncX = () => { const v = renderer.xView; setXv({ start: v.start, end: v.end }) }
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs)
  const [reducedMotion, setReducedMotion] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches)
  const [level, setLevel] = useState(renderer.model.depth)
  const [zoom, setZoom] = useState({ stops: [] as number[], at: 0 })
  const [tip, setTip] = useState<Tip | null>(null)
  const redraw = useRef<() => void>(() => {})
  const animateRef = useRef(prefs.animate && !reducedMotion)

  useEffect(() => savePrefs(prefs), [prefs])
  useEffect(() => {
    const mq = matchMedia('(prefers-reduced-motion: reduce)')
    const on = () => setReducedMotion(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  useEffect(() => {
    animateRef.current = prefs.animate && !reducedMotion
    redraw.current()
  }, [prefs.animate, reducedMotion])

  useEffect(() => {
    window.__r2traffic = renderer
    const anim = { running: false, frames: 0 }
    window.__r2trafficAnim = anim
    const el = host.current as HTMLDivElement
    const canvases = [baseCanvas.current, animCanvas.current, topCanvas.current] as HTMLCanvasElement[]
    const [bctx, actx, tctx] = canvases.map((c, i) => c.getContext('2d', { alpha: i > 0 }) as CanvasRenderingContext2D)
    let dpr = window.devicePixelRatio || 1
    let frame = 0
    let loop = 0
    let needBase = true
    let hover: { x: number; y: number } | null = null
    // The pattern clock: it stops while the animation is off, so the patterns stay put.
    let clock = 0
    let last = performance.now()
    const now = () => {
      const t = performance.now()
      if (animateRef.current) clock += (t - last) / 1000
      last = t
      return clock
    }
    const visible = () => el.clientWidth > 0 && document.visibilityState === 'visible'
    const updateTip = () => {
      if (!hover) return
      const l = renderer.linkAt(hover.x, hover.y)
      const key = l?.key ?? null
      if (key !== renderer.hoverKey) renderer.hoverKey = key
      if (l) { setTip({ x: hover.x, y: hover.y, content: renderer.linkTip(l) }); return }
      const b = renderer.busAt(hover.x, hover.y)
      if (b) { setTip({ x: hover.x, y: hover.y, content: renderer.busTip(b) }); return }
      // a gutter name: the whole name (it may be shortened)
      const g = renderer.gutterAt(hover.x, hover.y)
      setTip(g ? { x: hover.x, y: hover.y, content: { title: g.label, sections: [] } } : null)
    }
    const tick = () => {
      loop = 0
      if (!animateRef.current || !visible() || !renderer.moving) { anim.running = false; return }
      anim.running = true
      anim.frames++
      renderer.drawAnim(actx, dpr, now(), false)
      loop = requestAnimationFrame(tick)
    }
    const startLoop = () => {
      if (!loop && animateRef.current && visible() && renderer.moving) {
        last = performance.now()
        loop = requestAnimationFrame(tick)
      }
    }
    const draw = () => {
      frame = 0
      if (!visible()) return  // hidden: drawn again when shown (resize, visibility)
      if (needBase) {
        renderer.drawBase(bctx, dpr)
        renderer.drawAnim(actx, dpr, now(), true)
        setLevel(renderer.level)
        setPlot((p) => (p.left === renderer.plotLeft && p.width === renderer.plotW ? p : { left: renderer.plotLeft, width: renderer.plotW }))
        // The zoom slider: the cuts' stops (computed after the frame; cached per state).
        setTimeout(() => {
          const stops = renderer.zoomStops()
          setZoom({ stops, at: renderer.zoomStop(stops) })
        }, 0)
        needBase = false
      }
      updateTip()
      renderer.drawTop(tctx, dpr)
      startLoop()
    }
    const request = (base = true) => {
      needBase ||= base
      if (!frame) frame = requestAnimationFrame(draw)
    }
    redraw.current = () => request(true)
    const setRange = () => {
      const r = store.activeRange()
      renderer.setRange(r.a, r.b)
      request()
    }
    const resize = () => {
      const w = el.clientWidth
      const h = el.clientHeight
      if (w === 0 || h === 0) return  // hidden tab: keep the zoom
      dpr = window.devicePixelRatio || 1
      for (const c of canvases) {
        c.width = Math.round(w * dpr)
        c.height = Math.round(h * dpr)
        c.style.width = `${w}px`
        c.style.height = `${h}px`
      }
      renderer.resize(w, h)
      request()
    }
    const ro = new ResizeObserver(resize)
    ro.observe(el)
    resize()
    setRange()
    const onVisibility = () => request()
    document.addEventListener('visibilitychange', onVisibility)
    const offs = [store.window.subscribe(setRange), store.onTime(setRange), store.smoothing.subscribe(setRange),
      charges.subscribe(() => request()), onThemeChange(() => { renderer.theme = readTheme(); request() })]
    const top = canvases[2]
    const pos = (e: MouseEvent) => {
      const r = top.getBoundingClientRect()
      return { x: e.clientX - r.left, y: e.clientY - r.top }
    }
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const { x, y } = pos(e)
      const scale = e.deltaMode === 1 ? 16 : 1
      if (e.ctrlKey) { renderer.zoomXAt(x, zoomFactor(e.deltaY * scale)); syncX() }
      else if (e.altKey) renderer.zoomAt(y, zoomFactor(e.deltaY * scale))
      else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) { renderer.scrollXBy((e.deltaX || e.deltaY) * scale); syncX() }
      else renderer.scrollBy(e.deltaY * scale)
      request()
    }
    const onMove = (e: MouseEvent) => {
      hover = pos(e)
      top.style.cursor = renderer.clickable(hover.x, hover.y) ? 'pointer' : 'default'
      request(false)
    }
    // A click on a closed group splits it; on an open group's name in the gutter merges it.
    // A click on a strip selects its resources in the focus with the time shown (kept
    // fixed: their occupants are derived); shift adds or removes them, alt keeps the other
    // fixed parts.
    const onClick = (e: MouseEvent) => {
      const { x, y } = pos(e)
      if (renderer.clickAt(x, y)) { request(); return }
      const res = renderer.resourcesAt(x, y)
      if (!res) return
      const f = store.focus.get()
      let next = res
      if (e.shiftKey) {
        const cur = new Set(f.resources ?? [])
        const on = res.every((r) => cur.has(r))
        for (const r of res) { if (on) cur.delete(r); else cur.add(r) }
        next = [...cur]
      }
      const w = store.window.get()
      store.focus.set({ resources: next, time: f.time ?? { a: w.a, b: w.b } }, { keep: e.altKey, origin: 'instant' })
    }
    const applyFocus = () => {
      const r = store.focus.get().resources
      const next = new Set(r ?? [])
      if (next.size === renderer.focusResources.size && [...next].every((x) => renderer.focusResources.has(x))) return
      renderer.focusResources = next
      request(false)
    }
    applyFocus()
    offs.push(store.focus.subscribe(applyFocus))
    const onLeave = () => { hover = null; renderer.hoverKey = null; setTip(null); request(false) }
    top.addEventListener('wheel', onWheel, { passive: false })
    top.addEventListener('mousemove', onMove)
    top.addEventListener('mouseleave', onLeave)
    top.addEventListener('click', onClick)
    return () => {
      top.removeEventListener('click', onClick)
      ro.disconnect()
      offs.forEach((off) => off())
      document.removeEventListener('visibilitychange', onVisibility)
      top.removeEventListener('wheel', onWheel)
      top.removeEventListener('mousemove', onMove)
      top.removeEventListener('mouseleave', onLeave)
      if (frame) cancelAnimationFrame(frame)
      if (loop) cancelAnimationFrame(loop)
    }
  }, [renderer, store, charges])

  /** The scroll bar: dragging the thumb scrolls, dragging an end zooms, a press on the
   * track outside the thumb centers the view there. */
  const dragBar = (e: React.PointerEvent, mode: 'move' | 'left' | 'right' | 'page') => {
    if (e.button !== 0 || !bar.current) return
    e.stopPropagation()
    e.preventDefault()
    const track = bar.current.getBoundingClientRect()
    const v0 = renderer.xView
    if (mode === 'page') {
      const span = v0.end - v0.start
      const at = (e.clientX - track.left) / track.width - span / 2
      renderer.setXView(at, at + span)
      syncX()
      redraw.current()
      mode = 'move'
    }
    const v1 = renderer.xView
    const x0 = e.clientX
    const min = 1 / 16
    const move = (ev: PointerEvent) => {
      const d = (ev.clientX - x0) / track.width
      const span = v1.end - v1.start
      if (mode === 'move') { const s = Math.max(0, Math.min(1 - span, v1.start + d)); renderer.setXView(s, s + span) }
      else if (mode === 'left') renderer.setXView(Math.max(0, Math.min(v1.end - min, v1.start + d)), v1.end)
      else renderer.setXView(v1.start, Math.min(1, Math.max(v1.start + min, v1.end + d)))
      syncX()
      redraw.current()
    }
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const setClass = (cls: LinkClass, change: Partial<ClassOptions>) => {
    renderer.classes = { ...renderer.classes, [cls]: { ...renderer.classes[cls], ...change } }
    setPrefs((p) => ({ ...p, classes: renderer.classes }))
    redraw.current()
  }
  const setChannels = (channels: Prefs['channels']) => {
    renderer.channels = channels
    setPrefs((p) => ({ ...p, channels }))
    redraw.current()
  }
  const setScale = (on: boolean) => {
    renderer.scaleByBandwidth = on
    setPrefs((p) => ({ ...p, scaleByBandwidth: on }))
    redraw.current()
  }
  const undrawn = renderer.model.undrawn
  return (
    <div className="traffic">
      <div className="traffic-main">
        <div className="traffic-head">
          <span className="muted">depth {level} / {renderer.model.depth}</span>
          {renderer.rec.window && <span className="badge" title={renderer.rec.window ? `recorded ${cycles(renderer.rec.window[0])} – ${cycles(renderer.rec.window[1])}` : undefined}>windowed</span>}
          {undrawn.length > 0 && <span className="badge" title={`not drawn: ${undrawn.join(', ')}`}>
            {undrawn.length} links not drawn</span>}
          <span className="spacer" />
          {zoom.stops.length > 1 && (
            <input className="traffic-zoom" type="range" min={0} max={zoom.stops.length - 1} step={1} value={zoom.at}
              aria-label="zoom" title={`level ${zoom.at + 1} of ${zoom.stops.length}`}
              list={zoom.stops.length <= MAX_TICKS ? tickId : undefined}
              onChange={(e) => { renderer.zoomTo(zoom.stops[Number(e.target.value)]); redraw.current() }} />
          )}
          {zoom.stops.length <= MAX_TICKS && <datalist id={tickId}>{zoom.stops.map((_, i) => <option key={i} value={i} />)}</datalist>}
          <button className="button small" onClick={() => { renderer.fit(); renderer.setXView(0, 1); syncX(); redraw.current() }}>Fit</button>
        </div>
        <div className="traffic-body" ref={host}>
          <canvas ref={baseCanvas} />
          <canvas ref={animCanvas} />
          <canvas ref={topCanvas} />
          {tip && (
            <Tooltip tip={tip.content} style={{
              left: tip.x > renderer.width - 440 ? undefined : tip.x + 14,
              right: tip.x > renderer.width - 440 ? renderer.width - tip.x + 14 : undefined,
              top: tip.y > renderer.height - 240 ? undefined : tip.y + 14,
              bottom: tip.y > renderer.height - 240 ? renderer.height - tip.y + 14 : undefined }} />
          )}
        </div>
        <div className="traffic-hbar" ref={bar} style={{ marginLeft: plot.left, width: plot.width }}
          onPointerDown={(e) => dragBar(e, 'page')} onDoubleClick={() => { renderer.setXView(0, 1); syncX(); redraw.current() }}>
          <div className="traffic-thumb" style={{ left: `${xv.start * 100}%`, width: `${(xv.end - xv.start) * 100}%` }}
            onPointerDown={(e) => dragBar(e, 'move')}>
            <span className="traffic-grip left" onPointerDown={(e) => dragBar(e, 'left')} />
            <span className="traffic-grip right" onPointerDown={(e) => dragBar(e, 'right')} />
          </div>
        </div>
      </div>
      <Sidebar name="traffic">
        <Section title="Classes" view="traffic">
          {CLASS_ORDER.map((cls) => (
            <div key={cls} className="traffic-class">
              <label className="tool">
                <input type="checkbox" checked={prefs.classes[cls].visible} onChange={(e) => setClass(cls, { visible: e.target.checked })} />
                <span className="swatch" style={{ background: renderer.classColor(cls) }} />
                {cls}
              </label>
              <label className="tool traffic-class-sub">
                <input type="checkbox" checked={prefs.classes[cls].collapse} disabled={!prefs.classes[cls].visible}
                  onChange={(e) => setClass(cls, { collapse: e.target.checked })} />
                collapse when no traffic
              </label>
            </div>
          ))}
        </Section>
        <Section title="Strip width" view="traffic">
          <label className="tool">
            <input type="checkbox" checked={prefs.scaleByBandwidth} onChange={(e) => setScale(e.target.checked)} />
            scale width by bandwidth
          </label>
        </Section>
        <Section title="Read / write channels" view="traffic">
          {(['combined', 'separate'] as const).map((c) => (
            <label key={c} className="tool">
              <input type="radio" name="traffic-channels" checked={prefs.channels === c} onChange={() => setChannels(c)} />
              {c}
            </label>
          ))}
        </Section>
        <Section title="Motion" view="traffic">
          <label className="tool" title={reducedMotion ? 'off: reduced motion in the system settings' : undefined}>
            <input type="checkbox" checked={prefs.animate && !reducedMotion} disabled={reducedMotion}
              onChange={(e) => setPrefs((p) => ({ ...p, animate: e.target.checked }))} />
            animate the patterns
          </label>
        </Section>
      </Sidebar>
    </div>
  )
}
