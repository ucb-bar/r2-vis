import { useContext, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Trace } from '../data/trace'
import type { ViewStore } from '../state/viewstore'
import { onThemeChange, readTheme } from '../theme/theme'
import { BlockRenderer } from './renderer'
import { tipPlace, Tooltip, type TipContent } from '../ui/Tooltip'
import { pct, splitPath } from '../ui/format'
import { AreaContext, useAreaState } from '../ui/area'

declare global {
  interface Window { __r2blocks?: BlockRenderer }
}

interface Props {
  trace: Trace
  store: ViewStore
}

/** The block diagram view: wheel (or pinch) zooms around the cursor, drag pans,
 * double-click zooms to a box. A box's eye adds or removes it from the target timeline
 * (the most recently used one, state/workbench.ts); its target adds or removes it from the
 * attribution scope (state/viewstore.ts). The nodes of the focus tasks are outlined. */
export function BlockView({ trace, store }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [renderer] = useState(() => new BlockRenderer(trace, store.blocks, store.window.get(), readTheme()))
  const [checked, setChecked] = useState(store.blocks.get())
  const requestRef = useRef<() => void>(() => {})
  const [tip, setTip] = useState<{ x: number; y: number; content: TipContent } | null>(null)

  useEffect(() => {
    window.__r2blocks = renderer
    const el = host.current as HTMLDivElement
    const cv = canvas.current as HTMLCanvasElement
    const ctx = cv.getContext('2d', { alpha: false }) as CanvasRenderingContext2D
    let dpr = window.devicePixelRatio || 1
    let frame = 0
    // Hidden tab: no drawing; the resize when it is shown draws again.
    const draw = () => { frame = 0; if (el.clientWidth > 0) renderer.draw(ctx, dpr) }
    const request = () => { if (!frame) frame = requestAnimationFrame(draw) }
    requestRef.current = request
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
    // The attribution scope: the target icons.
    renderer.scope = store.scope.get()
    const offScope = store.scope.subscribe((s) => { renderer.scope = s; request() })
    // The nodes of the focus tasks are outlined.
    let tasks: readonly number[] | null = null
    const applyFocus = () => {
      const f = store.focus.get()
      if (f.tasks === tasks) return
      tasks = f.tasks
      const lane = trace.facts.tasks.cols.lane as Int32Array
      const nodes = new Set<number>()
      for (const t of tasks ?? []) {
        const n = trace.dims.lanes[lane[t]]?.node as number | undefined
        if (n !== undefined) nodes.add(n)
      }
      renderer.focusNodes = nodes
      request()
    }
    applyFocus()
    const offFocus = store.focus.subscribe(applyFocus)
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
      if (toggle) {
        setTip({ x, y, content: { title: toggle.kind === 'timeline' ? 'In the timeline' : 'Attribution scope', sections: [] } })
        return
      }
      // A box drawn with its strips shows its values already.
      if (box && !renderer.showsStrips(box)) {
        const avgs = renderer.metrics.averages(box.node, renderer.window.a, renderer.window.b)
        const rows = (avgs ?? []).map((m) => ({ label: m.name, value: pct(m.value) }))
        const { name, parent } = splitPath(box.path)
        setTip({ x, y, content: { title: name, path: parent,
          sections: avgs === null ? [{ kind: 'note', text: 'not recorded' }] : rows.length ? [{ kind: 'rows', rows }] : [] } })
      } else setTip(null)
    }
    const onUp = (e: PointerEvent) => {
      const d = drag
      drag = null
      if (!d || d.moved) return
      const { x, y } = pos(e)
      const toggle = renderer.toggleAt(x, y)
      if (toggle?.kind === 'timeline') store.blocks.setChecked(toggle.node, !store.blocks.has(toggle.node))
      else if (toggle?.kind === 'scope') {
        const next = new Set(store.scope.get())
        if (next.has(toggle.node)) next.delete(toggle.node)
        else next.add(toggle.node)
        store.scope.set(next)
      }
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
      offFocus()
      offScope()
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

  // The node set of the target timeline, and its changes.
  useEffect(() => {
    let offSet = () => {}
    const follow = (sel: typeof renderer.blocks) => {
      offSet()
      renderer.blocks = sel
      setChecked(sel.get())
      requestRef.current()
      offSet = sel.subscribe((b) => { setChecked(b); requestRef.current() })
    }
    follow(store.targetBlocks.get())
    const offTarget = store.targetBlocks.subscribe(follow)
    return () => { offTarget(); offSet() }
  }, [renderer, store])

  // The "In the timeline" list: a button in the area header (in the diagram's corner outside
  // an area); open, it closes on a click outside or Esc. Kept per area.
  const area = useContext(AreaContext)
  const [panelOpen, setPanelOpen] = useAreaState<boolean>('blocks.panel', () => false)
  const corner = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!panelOpen) return
    const away = (e: PointerEvent) => { if (!corner.current?.contains(e.target as globalThis.Node)) setPanelOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setPanelOpen(false) }
    window.addEventListener('pointerdown', away)
    window.addEventListener('keydown', esc)
    return () => { window.removeEventListener('pointerdown', away); window.removeEventListener('keydown', esc) }
  }, [panelOpen, setPanelOpen])

  const inTimeline = trace.dims.nodes.filter((n) => checked.has(n.id as number))
  const list = (
    <div className={area?.slot ? 'float-corner in-head' : 'float-corner'} ref={corner}>
      <button className={panelOpen ? 'button small active' : 'button small'} aria-expanded={panelOpen}
        onClick={() => setPanelOpen(!panelOpen)}>In the timeline ({inTimeline.length})</button>
      {panelOpen && (
        <div className="float-panel">
          <div className="float-panel-head">
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
      )}
    </div>
  )
  return (
    <div className="block-view" ref={host}>
      <canvas ref={canvas} className="block-canvas" />
      {tip && <Tooltip tip={tip.content} style={tipPlace(tip, host.current)} />}
      {area?.slot ? createPortal(list, area.slot) : list}
    </div>
  )
}
