import { useEffect, useRef, useState } from 'react'
import type { ChargeCache } from '../data/charges'
import type { Trace } from '../data/trace'
import type { ViewStore } from '../state/viewstore'
import { onThemeChange, readTheme } from '../theme/theme'
import { zoomFactor } from '../timeline/viewport'
import { Section, Sidebar } from '../ui/Sidebar'
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

interface Tip {
  x: number
  y: number
  title: string
  lines: string[]
}

interface Prefs {
  scaleByBandwidth: boolean
  animate: boolean
  classes: Record<LinkClass, ClassOptions>
}

const PREFS_KEY = 'r2vis.traffic'

function loadClasses(saved: Partial<Record<LinkClass, Partial<ClassOptions>>> | undefined): Record<LinkClass, ClassOptions> {
  return Object.fromEntries(CLASS_ORDER.map((c) => [c, { visible: saved?.[c]?.visible !== false, collapse: saved?.[c]?.collapse !== false }])) as
    Record<LinkClass, ClassOptions>
}

function loadPrefs(): Prefs {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '') as Partial<Prefs>
    return { scaleByBandwidth: p.scaleByBandwidth === true, animate: p.animate !== false, classes: loadClasses(p.classes) }
  } catch {
    return { scaleByBandwidth: false, animate: true, classes: loadClasses(undefined) }
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
 * scrolls, ctrl+wheel (or pinch) zooms the y axis; levels below about 20 px per row are
 * aggregated per parent. Three stacked canvases: the base and the top layer are drawn on a
 * change; only the pattern layer between them is drawn per animation frame. */
export function TrafficView({ trace, charges, store }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const baseCanvas = useRef<HTMLCanvasElement>(null)
  const animCanvas = useRef<HTMLCanvasElement>(null)
  const topCanvas = useRef<HTMLCanvasElement>(null)
  const [renderer] = useState(() => {
    const r = new TrafficRenderer(trace, charges, readTheme())
    const p = loadPrefs()
    r.scaleByBandwidth = p.scaleByBandwidth
    r.classes = p.classes
    return r
  })
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs)
  const [reducedMotion, setReducedMotion] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches)
  const [level, setLevel] = useState(renderer.model.depth)
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
      if (!l) { setTip(null); return }
      const lines = renderer.notRecorded(l) ? ['not recorded in this dump'] : renderer.detail(l)
      if (!renderer.notRecorded(l)) {
        const top = renderer.topKinds(l)
        if (top === 'loading') lines.push('task kinds: loading the charges…')
        else if (top === 'too long') lines.push('task kinds: select a shorter range')
        else if (top.length) lines.push(`task kinds: ${top.map((k) => `${k.name} ${(100 * k.share).toFixed(0)} %`).join(', ')}`)
      }
      setTip({ x: hover.x, y: hover.y, title: `${l.name} · ${l.cls}`, lines })
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
    const offs = [store.window.subscribe(setRange), store.range.subscribe(setRange),
      store.cursor.subscribe(setRange), store.followCursor.subscribe(setRange), store.smoothing.subscribe(setRange),
      charges.subscribe(() => request()), onThemeChange(() => { renderer.theme = readTheme(); request() })]
    const top = canvases[2]
    const pos = (e: MouseEvent) => {
      const r = top.getBoundingClientRect()
      return { x: e.clientX - r.left, y: e.clientY - r.top }
    }
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const { y } = pos(e)
      const scale = e.deltaMode === 1 ? 16 : 1
      if (e.ctrlKey) renderer.zoomAt(y, zoomFactor(e.deltaY * scale))
      else renderer.scrollBy(e.deltaY * scale)
      request()
    }
    const onMove = (e: MouseEvent) => { hover = pos(e); request(false) }
    const onLeave = () => { hover = null; renderer.hoverKey = null; setTip(null); request(false) }
    top.addEventListener('wheel', onWheel, { passive: false })
    top.addEventListener('mousemove', onMove)
    top.addEventListener('mouseleave', onLeave)
    return () => {
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

  const setClass = (cls: LinkClass, change: Partial<ClassOptions>) => {
    renderer.classes = { ...renderer.classes, [cls]: { ...renderer.classes[cls], ...change } }
    setPrefs((p) => ({ ...p, classes: renderer.classes }))
    redraw.current()
  }
  const setScale = (on: boolean) => {
    renderer.scaleByBandwidth = on
    setPrefs((p) => ({ ...p, scaleByBandwidth: on }))
    redraw.current()
  }
  const full = level === renderer.model.depth
  const levelName = full ? 'all levels drawn' : `drawn to depth ${level} of ${renderer.model.depth}, deeper levels aggregated`
  return (
    <div className="traffic">
      <div className="traffic-main">
        <div className="traffic-head">
          <span className="muted">{prefs.scaleByBandwidth ? 'width = √ bandwidth' : 'text: utilization · throughput'} · pattern speed = utilization
            · {levelName}
            {renderer.rec.window ? ' · loads average over the recorded time window only' : ''}
            {renderer.model.undrawn.length ? ` · not drawn: ${renderer.model.undrawn.length} links that are caches or join no node to its parent (${renderer.model.undrawn.join(', ')})` : ''}</span>
          <span className="spacer" />
          <button className="button small" onClick={() => { renderer.fit(); redraw.current() }}>Fit</button>
        </div>
        <div className="traffic-body" ref={host}>
          <canvas ref={baseCanvas} />
          <canvas ref={animCanvas} />
          <canvas ref={topCanvas} />
          {tip && (
            <div className="tooltip" style={{
              left: tip.x > renderer.width - 440 ? undefined : tip.x + 14,
              right: tip.x > renderer.width - 440 ? renderer.width - tip.x + 14 : undefined,
              top: tip.y > renderer.height - 120 ? undefined : tip.y + 14,
              bottom: tip.y > renderer.height - 120 ? renderer.height - tip.y + 14 : undefined }}>
              <div className="tooltip-title">{tip.title}</div>
              {tip.lines.map((l) => <div key={l}>{l}</div>)}
            </div>
          )}
        </div>
      </div>
      <Sidebar name="traffic">
        <Section title="Classes">
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
          <div className="muted">collapsed: a link with no traffic in the range is a thin line; a dashed grey line: not recorded</div>
        </Section>
        <Section title="Strip width">
          <label className="tool">
            <input type="checkbox" checked={prefs.scaleByBandwidth} onChange={(e) => setScale(e.target.checked)} />
            scale width by bandwidth
          </label>
          <div className="muted">{prefs.scaleByBandwidth
            ? 'square root of bw_bytes (an unlimited link: its peak in the run, dashed outline); no text'
            : 'every strip 18 px high, with its utilization and throughput'}</div>
        </Section>
        <Section title="Motion">
          <label className="tool">
            <input type="checkbox" checked={prefs.animate && !reducedMotion} disabled={reducedMotion}
              onChange={(e) => setPrefs((p) => ({ ...p, animate: e.target.checked }))} />
            animate the patterns
          </label>
          {reducedMotion && <div className="muted">off: the system asks for reduced motion</div>}
          <div className="muted">speed = utilization (100 % = 80 px/s); chevrons: the direction; a link with traffic both ways over the run: two strips (top: in / up, bottom: out / down); still stripes: no traffic in the range</div>
        </Section>
      </Sidebar>
    </div>
  )
}
