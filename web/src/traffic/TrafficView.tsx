import { useEffect, useRef, useState } from 'react'
import type { ChargeCache } from '../data/charges'
import type { Trace } from '../data/trace'
import type { ViewStore } from '../state/viewstore'
import { onThemeChange, readTheme } from '../theme/theme'
import { zoomFactor } from '../timeline/viewport'
import { CLASS_ORDER, type LinkClass } from './model'
import { TrafficRenderer } from './renderer'

declare global {
  interface Window { __r2traffic?: TrafficRenderer }
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

/** The traffic view: the fabric at the active time range of the shared state. Wheel
 * scrolls, ctrl+wheel (or pinch) zooms the y axis; levels below about 20 px per row are
 * aggregated per parent. */
export function TrafficView({ trace, charges, store }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [renderer] = useState(() => new TrafficRenderer(trace, charges, readTheme()))
  const [show, setShow] = useState(renderer.show)
  const [level, setLevel] = useState(renderer.model.depth)
  const [tip, setTip] = useState<Tip | null>(null)
  const redraw = useRef<() => void>(() => {})

  useEffect(() => {
    window.__r2traffic = renderer
    const el = host.current as HTMLDivElement
    const cv = canvas.current as HTMLCanvasElement
    const ctx = cv.getContext('2d', { alpha: false }) as CanvasRenderingContext2D
    let dpr = window.devicePixelRatio || 1
    let frame = 0
    let hover: { x: number; y: number } | null = null
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
    const draw = () => {
      frame = 0
      renderer.draw(ctx, dpr)
      setLevel(renderer.level)
      updateTip()
    }
    const request = () => { if (!frame) frame = requestAnimationFrame(draw) }
    redraw.current = request
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
      cv.width = Math.round(w * dpr)
      cv.height = Math.round(h * dpr)
      cv.style.width = `${w}px`
      cv.style.height = `${h}px`
      renderer.resize(w, h)
      request()
    }
    const ro = new ResizeObserver(resize)
    ro.observe(el)
    resize()
    setRange()
    const offs = [store.window.subscribe(setRange), store.range.subscribe(setRange),
      store.cursor.subscribe(setRange), store.followCursor.subscribe(setRange), store.smoothing.subscribe(setRange),
      charges.subscribe(request), onThemeChange(() => { renderer.theme = readTheme(); request() })]
    const pos = (e: MouseEvent) => {
      const r = cv.getBoundingClientRect()
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
    const onMove = (e: MouseEvent) => { hover = pos(e); request() }
    const onLeave = () => { hover = null; renderer.hoverKey = null; setTip(null); request() }
    cv.addEventListener('wheel', onWheel, { passive: false })
    cv.addEventListener('mousemove', onMove)
    cv.addEventListener('mouseleave', onLeave)
    return () => {
      ro.disconnect()
      offs.forEach((off) => off())
      cv.removeEventListener('wheel', onWheel)
      cv.removeEventListener('mousemove', onMove)
      cv.removeEventListener('mouseleave', onLeave)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [renderer, store, charges])

  const toggle = (cls: LinkClass) => {
    renderer.show = { ...renderer.show, [cls]: !renderer.show[cls] }
    setShow(renderer.show)
    redraw.current()
  }
  const full = level === renderer.model.depth
  const levelName = full ? 'all levels drawn' : `drawn to depth ${level} of ${renderer.model.depth}, deeper levels aggregated`
  return (
    <div className="traffic">
      <div className="traffic-head">
        {CLASS_ORDER.map((cls) => (
          <label key={cls} className="tool">
            <input type="checkbox" checked={show[cls]} onChange={() => toggle(cls)} />
            <span className="ramp" style={{ background: `linear-gradient(90deg, ${renderer.rampColor(cls, 0)}, ${renderer.rampColor(cls, 1)})` }} />
            {cls}
          </label>
        ))}
        <span className="muted">load = lightness, 0 to 100 % of the ceiling · {levelName}
          {renderer.rec.window ? ' · loads average over the recorded time window only' : ''}
          {renderer.model.undrawn.length ? ` · not drawn: ${renderer.model.undrawn.length} links that are caches or join no node to its parent (${renderer.model.undrawn.join(', ')})` : ''}</span>
        <span className="spacer" />
        <button className="button small" onClick={() => { renderer.fit(); redraw.current() }}>Fit</button>
      </div>
      <div className="traffic-body" ref={host}>
        <canvas ref={canvas} />
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
  )
}
