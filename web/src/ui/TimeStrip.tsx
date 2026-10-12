import { useEffect, useRef, useState } from 'react'
import { sameRange, type ViewStore } from '../state/viewstore'
import { onThemeChange, readTheme } from '../theme/theme'
import { AXIS, GUTTER, TimeAxis } from '../timeline/axis'
import { Minimap } from '../timeline/Minimap'
import type { TimelineRenderer } from '../timeline/renderer'
import { TimeInput } from '../timeline/timeinput'

const TRACK = 12   // the band under the axis that shows the range and the cursor
const MAP_KEY = 'r2vis.strip'
const MAP_MIN = 24
const MAP_MAX = 240

function loadMapHeight(): number {
  try {
    const v = Number(JSON.parse(localStorage.getItem(MAP_KEY) ?? '{}').minimap)
    return v >= MAP_MIN && v <= MAP_MAX ? v : 52
  } catch {
    return 52
  }
}

interface Props {
  store: ViewStore
  /** the timeline's renderer: its minimap (focus row, window box) is shown here too */
  timeline: TimelineRenderer
}

declare global {
  interface Window { __r2strip?: TimeAxis }
}

/** The Instant tab's scrubber (views-design 6.1): the timeline's axis with the window,
 * range band, cursor and pin of the shared store, and the timeline's minimap, with the
 * same input as the timeline (TimeInput). */
export function TimeStrip({ store, timeline }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [axis] = useState(() => new TimeAxis(timeline.endTime, timeline.axis.home))
  const [mapVersion, setMapVersion] = useState(0)
  const [pinned, setPinned] = useState<number | null>(store.cursor.get()?.pinned ? (store.cursor.get()?.t ?? null) : null)
  const [mapHeight, setMapHeight] = useState(loadMapHeight)
  const divider = useRef<{ y: number; h: number } | null>(null)
  useEffect(() => {
    try {
      localStorage.setItem(MAP_KEY, JSON.stringify({ minimap: mapHeight }))
    } catch {
      // storage unavailable: the height is not kept
    }
  }, [mapHeight])

  useEffect(() => {
    window.__r2strip = axis
    const el = host.current as HTMLDivElement
    const cv = canvas.current as HTMLCanvasElement
    const ctx = cv.getContext('2d', { alpha: false }) as CanvasRenderingContext2D
    let theme = readTheme()
    let dpr = window.devicePixelRatio || 1
    let frame = 0
    let hoverX: number | null = null
    const draw = () => {
      frame = 0
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.fillStyle = theme.surface
      ctx.fillRect(0, 0, axis.width, AXIS + TRACK)
      axis.drawBands(ctx, theme, AXIS, AXIS + TRACK)
      axis.drawAxis(ctx, theme)
      axis.drawCursor(ctx, theme, AXIS, AXIS + TRACK, hoverX)
    }
    const request = () => { if (!frame) frame = requestAnimationFrame(draw) }
    // Window: the store's (set by the timeline, or by this strip).
    let publishing = false
    axis.onView = () => {
      if (publishing) return
      const w = axis.window
      publishing = true
      store.window.set({ a: w.a, b: w.b, cpp: axis.view.cpp })
      publishing = false
      setMapVersion((v) => v + 1)
      request()
    }
    const showStore = () => {
      const w = store.window.get()
      publishing = true
      axis.showWindow(w.a, w.b)
      publishing = false
      setMapVersion((v) => v + 1)
      request()
    }
    const resize = () => {
      const w = el.clientWidth
      if (w === 0) return  // hidden: keep the view
      dpr = window.devicePixelRatio || 1
      cv.width = Math.round(w * dpr)
      cv.height = Math.round((AXIS + TRACK) * dpr)
      cv.style.width = `${w}px`
      cv.style.height = `${AXIS + TRACK}px`
      publishing = true
      axis.resize(w)
      publishing = false
      showStore()
    }
    const ro = new ResizeObserver(resize)
    ro.observe(el)
    resize()
    const syncRange = () => {
      const r = store.range.get()
      if (!sameRange(r, axis.selection)) { axis.selection = r ? { ...r } : null; request() }
    }
    const syncCursor = () => {
      const c = store.cursor.get()
      axis.pinned = c?.pinned ? c.t : null
      setPinned(axis.pinned)
      request()
    }
    syncRange()
    syncCursor()
    const offs = [store.window.subscribe(showStore), store.range.subscribe(syncRange),
      store.cursor.subscribe(syncCursor), onThemeChange(() => { theme = readTheme(); request() })]

    const time = new TimeInput({
      axis, store,
      changed: request,
      rangeChanged: () => {
        const r = axis.selection && axis.selection.b > axis.selection.a ? { ...axis.selection } : null
        if (!sameRange(r, store.range.get())) store.range.set(r)
      },
    })
    const pos = (e: MouseEvent) => {
      const r = cv.getBoundingClientRect()
      return { x: e.clientX - r.left, y: e.clientY - r.top }
    }
    const onWheel = (e: WheelEvent) => {
      if (time.wheel(e, pos(e).x, AXIS + TRACK)) e.preventDefault()
    }
    const onDown = (e: PointerEvent) => {
      const { x, y } = pos(e)
      if (time.down(e, x, y)) cv.setPointerCapture(e.pointerId)
    }
    const onMove = (e: PointerEvent) => {
      const { x, y } = pos(e)
      hoverX = x >= GUTTER ? x : null
      if (!time.move(x)) cv.style.cursor = time.cursorAt(x, y) ?? 'default'
      request()
    }
    const onUp = (e: PointerEvent) => {
      const { x, y } = pos(e)
      time.up(e, x, y)
    }
    const onLeave = () => { hoverX = null; request() }
    const onDouble = (e: MouseEvent) => { const { x, y } = pos(e); time.double(x, y) }
    const noMenu = (e: Event) => e.preventDefault()
    cv.addEventListener('wheel', onWheel, { passive: false })
    cv.addEventListener('pointerdown', onDown)
    cv.addEventListener('pointermove', onMove)
    cv.addEventListener('pointerup', onUp)
    cv.addEventListener('pointercancel', onUp)
    cv.addEventListener('mouseleave', onLeave)
    cv.addEventListener('dblclick', onDouble)
    cv.addEventListener('contextmenu', noMenu)
    return () => {
      ro.disconnect()
      offs.forEach((off) => off())
      axis.onView = null
      cv.removeEventListener('wheel', onWheel)
      cv.removeEventListener('pointerdown', onDown)
      cv.removeEventListener('pointermove', onMove)
      cv.removeEventListener('pointerup', onUp)
      cv.removeEventListener('pointercancel', onUp)
      cv.removeEventListener('mouseleave', onLeave)
      cv.removeEventListener('dblclick', onDouble)
      cv.removeEventListener('contextmenu', noMenu)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [axis, store, timeline])

  return (
    <div className="time-strip" ref={host}>
      <canvas ref={canvas} />
      {pinned !== null && (
        <span className="chip time-strip-pin">pinned at {Math.round(pinned).toLocaleString('en-US')}
          <button className="chip-x" aria-label="unpin" onClick={() => store.unpin()}>×</button></span>
      )}
      <Minimap renderer={timeline} axis={axis} version={mapVersion} onChange={() => setMapVersion((v) => v + 1)} height={mapHeight} />
      <div className="strip-divider" title="drag to resize the minimap"
        onPointerDown={(e) => { e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); divider.current = { y: e.clientY, h: mapHeight } }}
        onPointerMove={(e) => {
          const d = divider.current
          if (d) setMapHeight(Math.max(MAP_MIN, Math.min(MAP_MAX, Math.round(d.h + e.clientY - d.y))))
        }}
        onPointerUp={() => { divider.current = null }}
        onPointerCancel={() => { divider.current = null }} />
    </div>
  )
}
