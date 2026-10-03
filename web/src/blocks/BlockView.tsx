import { useEffect, useRef, useState } from 'react'
import type { Trace } from '../data/trace'
import type { ViewStore } from '../state/viewstore'
import { onThemeChange, readTheme } from '../theme/theme'
import { BlockRenderer } from './renderer'

declare global {
  interface Window { __r2blocks?: BlockRenderer }
}

interface Props {
  trace: Trace
  store: ViewStore
}

/** The block diagram view: wheel (or pinch) zooms around the cursor, drag pans,
 * double-click zooms to a box, the box toggle adds or removes it from the timeline. */
export function BlockView({ trace, store }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [renderer] = useState(() => new BlockRenderer(trace, store.blocks, store.window.get(), readTheme()))
  const [checked, setChecked] = useState(store.blocks.get())
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null)

  useEffect(() => {
    window.__r2blocks = renderer
    const el = host.current as HTMLDivElement
    const cv = canvas.current as HTMLCanvasElement
    const ctx = cv.getContext('2d', { alpha: false }) as CanvasRenderingContext2D
    let dpr = window.devicePixelRatio || 1
    let frame = 0
    const draw = () => { frame = 0; renderer.draw(ctx, dpr) }
    const request = () => { if (!frame) frame = requestAnimationFrame(draw) }
    const resize = () => {
      const w = el.clientWidth
      const h = el.clientHeight
      if (w === 0 || h === 0) return  // hidden tab: keep the camera
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
    const offWindow = store.window.subscribe((w) => { renderer.setWindow(w); request() })
    const offBlocks = store.blocks.subscribe((b) => { setChecked(b); request() })
    const offTheme = onThemeChange(() => { renderer.theme = readTheme(); request() })
    const pos = (e: MouseEvent) => {
      const r = cv.getBoundingClientRect()
      return { x: e.clientX - r.left, y: e.clientY - r.top }
    }
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const { x, y } = pos(e)
      const scale = e.deltaMode === 1 ? 16 : 1
      if (!e.ctrlKey && (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY))) {
        renderer.pan(-(e.deltaX || e.deltaY) * scale, 0)
      } else renderer.zoomAt(x, y, Math.exp(-e.deltaY * scale * (e.ctrlKey ? 0.01 : 0.002)))
      request()
    }
    let drag: { x: number; y: number; moved: boolean } | null = null
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return
      const { x, y } = pos(e)
      drag = { x, y, moved: false }
      cv.setPointerCapture(e.pointerId)
    }
    const onMove = (e: PointerEvent) => {
      const { x, y } = pos(e)
      if (drag) {
        if (!drag.moved && Math.hypot(x - drag.x, y - drag.y) <= 3) return
        drag.moved = true
        renderer.pan(x - drag.x, y - drag.y)
        drag.x = x
        drag.y = y
        setTip(null)
        request()
        return
      }
      const box = renderer.boxAtScreen(x, y)
      const node = box?.node ?? null
      if (node !== renderer.hoverNode) { renderer.hoverNode = node; request() }
      const toggle = renderer.toggleAt(x, y)
      cv.style.cursor = toggle !== null ? 'pointer' : 'grab'
      if (box) {
        const u = renderer.metrics.computeAverage(box.node, renderer.window.a, renderer.window.b)
        const inTl = store.blocks.has(box.node) ? 'in the timeline' : 'not in the timeline'
        setTip({ x, y, text: `${box.path} · tensor ${u === u ? `${(100 * u).toFixed(1)} %` : 'none'} over the window · ${inTl}` })
      } else setTip(null)
    }
    const onUp = (e: PointerEvent) => {
      const d = drag
      drag = null
      if (!d || d.moved) return
      const { x, y } = pos(e)
      const toggle = renderer.toggleAt(x, y)
      if (toggle !== null) store.blocks.setChecked(toggle, !store.blocks.has(toggle))
    }
    const onDouble = (e: MouseEvent) => {
      const { x, y } = pos(e)
      if (renderer.toggleAt(x, y) !== null) return
      const box = renderer.boxAtScreen(x, y)
      if (box) { renderer.fit(box); request() }
    }
    const onLeave = () => { renderer.hoverNode = null; setTip(null); request() }
    cv.addEventListener('wheel', onWheel, { passive: false })
    cv.addEventListener('pointerdown', onDown)
    cv.addEventListener('pointermove', onMove)
    cv.addEventListener('pointerup', onUp)
    cv.addEventListener('dblclick', onDouble)
    cv.addEventListener('mouseleave', onLeave)
    return () => {
      ro.disconnect()
      offWindow()
      offBlocks()
      offTheme()
      cv.removeEventListener('wheel', onWheel)
      cv.removeEventListener('pointerdown', onDown)
      cv.removeEventListener('pointermove', onMove)
      cv.removeEventListener('pointerup', onUp)
      cv.removeEventListener('dblclick', onDouble)
      cv.removeEventListener('mouseleave', onLeave)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [renderer, store])

  const inTimeline = trace.dims.nodes.filter((n) => checked.has(n.id as number))
  return (
    <div className="block-view" ref={host}>
      <canvas ref={canvas} className="block-canvas" />
      {tip && <div className="tooltip" style={{ left: tip.x + 14, top: tip.y + 14 }}>{tip.text}</div>}
      <div className="float-panel">
        <div className="float-panel-head">
          <strong>In the timeline</strong>
          <span className="spacer" />
          <button className="button small" onClick={() => renderer.fit(renderer.root)}>Fit</button>
        </div>
        {inTimeline.length === 0 && <div className="menu-empty">none</div>}
        {inTimeline.map((n) => (
          <div key={n.id as number} className="float-item">
            <span>{String(n.path)}</span>
            <button className="chip-x" aria-label={`remove ${n.path}`}
              onClick={() => store.blocks.setChecked(n.id as number, false)}>×</button>
          </div>
        ))}
      </div>
    </div>
  )
}
