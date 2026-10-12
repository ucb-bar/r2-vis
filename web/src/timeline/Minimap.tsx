import { useEffect, useRef } from 'react'
import { onThemeChange, readTheme } from '../theme/theme'
import type { TimeAxis } from './axis'
import { GUTTER, type TimelineRenderer } from './renderer'
import { laneBusy, sampleBins, sampleFabric } from './util'
import { zoomFactor } from './viewport'

const HEIGHT = 52     // default height (px); the Instant scrubber's is adjustable
const EDGE_PX = 6

interface Props {
  renderer: TimelineRenderer
  /** Increments when the main view or the focus row changes. */
  version: number
  onChange: () => void
  height?: number
  /** the time axis whose window the box shows and moves (default: the timeline's; the
   * Instant scrubber's own, which has a size when the timeline was never shown) */
  axis?: TimeAxis
}

/** Minimap and scrollbar: the full-run series of the focus row, with a box for the shown
 * range. Drag the box to pan, drag its edges to zoom, click outside it to center there. */
export function Minimap({ renderer, version, onChange, height = HEIGHT, axis: shown }: Props) {
  const axis = shown ?? renderer.axis
  const canvas = useRef<HTMLCanvasElement>(null)
  const series = useRef<{ key: string | null; width: number; height: number; theme: string; image: HTMLCanvasElement | null }>({ key: null, width: 0, height: 0, theme: '', image: null })

  // Drawn on the next frame: the timeline renderer (the series' line color) takes the new
  // tokens in its own handler, which may run after this one.
  useEffect(() => onThemeChange(() => { series.current.theme = ''; requestAnimationFrame(draw) }), [])

  const geometry = () => {
    const cv = canvas.current as HTMLCanvasElement
    const width = cv.clientWidth
    const plot = Math.max(1, width - GUTTER)
    const end = renderer.endTime
    return { width, plot, cpp: end / plot }
  }

  const draw = () => {
    const cv = canvas.current
    if (!cv) return
    const th = readTheme()
    const dpr = window.devicePixelRatio || 1
    const { width, plot, cpp } = geometry()
    if (cv.width !== Math.round(width * dpr) || cv.height !== Math.round(height * dpr)) {
      cv.width = Math.round(width * dpr)
      cv.height = Math.round(height * dpr)
    }
    const ctx = cv.getContext('2d') as CanvasRenderingContext2D
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const row = renderer.focusRow()
    const s = series.current
    // the renderer's tokens: the series is drawn with its line colors
    const themeKey = renderer.theme.accent + renderer.theme.surface
    if (s.key !== (row?.key ?? null) || s.width !== width || s.theme !== themeKey || s.height !== height) {
      s.key = row?.key ?? null
      s.width = width
      s.theme = themeKey
      s.height = height
      const line = row && (row.kind === 'resource' || row.kind === 'fabric') ? renderer.lineColorOf(row) : th.accent
      s.image = renderSeries(renderer, row?.key ?? null, plot, cpp, line, line, dpr, Math.max(8, height - 12))
    }
    ctx.fillStyle = th.surface
    ctx.fillRect(0, 0, width, height)
    ctx.fillStyle = th.axis
    ctx.fillRect(0, 0, width, 1)
    ctx.fillStyle = th.inkMuted
    ctx.font = `${th.fontSizeXs}px ${th.fontSans}`
    ctx.textBaseline = 'middle'
    const label = row ? `${String(renderer.trace.dims.nodes[row.node].path)}.${row.label}` : ''
    ctx.fillText(label.length > 44 ? `…${label.slice(-43)}` : label, 10, height / 2)
    cv.title = row ? '' : 'click a row label in the timeline to show its series here'
    if (s.image) ctx.drawImage(s.image, GUTTER, 4, plot, height - 8)
    // The box of the shown range.
    const v = axis.view
    const x0 = GUTTER + v.t0 / cpp
    const x1 = GUTTER + (v.t0 + axis.plotWidth * v.cpp) / cpp
    const l = Math.max(GUTTER, x0)
    const r = Math.min(width, Math.max(l + 3, x1))
    ctx.fillStyle = th.hover
    ctx.fillRect(GUTTER, 2, l - GUTTER, height - 4)
    ctx.fillRect(r, 2, width - r, height - 4)
    ctx.strokeStyle = th.ink
    ctx.lineWidth = 1.5
    ctx.strokeRect(l + 0.75, 2.75, r - l - 1.5, height - 5.5)
    ctx.fillStyle = th.ink
    ctx.fillRect(l, height / 2 - 8, 3, 16)
    ctx.fillRect(r - 3, height / 2 - 8, 3, 16)
  }

  useEffect(draw, [version, height])

  useEffect(() => {
    const cv = canvas.current as HTMLCanvasElement
    let drag: { mode: 'move' | 'left' | 'right'; x0: number; t0: number; t1: number } | null = null
    const span = () => axis.plotWidth * axis.view.cpp
    const timeOf = (x: number) => (x - GUTTER) * geometry().cpp
    const down = (e: PointerEvent) => {
      const x = e.offsetX
      if (x < GUTTER || e.button !== 0) return
      const { cpp } = geometry()
      const v = axis.view
      const x0 = GUTTER + v.t0 / cpp
      const x1 = GUTTER + (v.t0 + span()) / cpp
      cv.setPointerCapture(e.pointerId)
      if (Math.abs(x - x0) <= EDGE_PX) drag = { mode: 'left', x0: x, t0: v.t0, t1: v.t0 + span() }
      else if (Math.abs(x - x1) <= EDGE_PX) drag = { mode: 'right', x0: x, t0: v.t0, t1: v.t0 + span() }
      else if (x > x0 && x < x1) drag = { mode: 'move', x0: x, t0: v.t0, t1: v.t0 + span() }
      else {
        // Center the view on the clicked time.
        axis.setView({ t0: timeOf(x) - span() / 2, cpp: v.cpp })
        drag = { mode: 'move', x0: x, t0: axis.view.t0, t1: axis.view.t0 + span() }
        onChange()
      }
    }
    const move = (e: PointerEvent) => {
      const x = e.offsetX
      if (!drag) {
        const { cpp } = geometry()
        const v = axis.view
        const x0 = GUTTER + v.t0 / cpp
        const x1 = GUTTER + (v.t0 + span()) / cpp
        cv.style.cursor = x >= GUTTER && (Math.abs(x - x0) <= EDGE_PX || Math.abs(x - x1) <= EDGE_PX) ? 'ew-resize'
          : x > x0 && x < x1 ? 'grab' : 'default'
        return
      }
      const dt = (x - drag.x0) * geometry().cpp
      const pw = axis.plotWidth
      if (drag.mode === 'move') axis.setView({ t0: drag.t0 + dt, cpp: axis.view.cpp })
      else if (drag.mode === 'left') {
        const t0 = Math.min(drag.t0 + dt, drag.t1 - pw / 64)
        axis.setView({ t0, cpp: (drag.t1 - t0) / pw })
      } else {
        const t1 = Math.max(drag.t1 + dt, drag.t0 + pw / 64)
        axis.setView({ t0: drag.t0, cpp: (t1 - drag.t0) / pw })
      }
      onChange()
    }
    const up = () => { drag = null }
    // Wheel: ctrl+wheel or a trackpad pinch zooms the view around its center (and not the
    // page); horizontal or shift+wheel pans. A plain vertical wheel is left to the page.
    const wheel = (e: WheelEvent) => {
      const horizontal = !e.ctrlKey && (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY))
      if (!horizontal && !e.ctrlKey) return
      e.preventDefault()
      const scale = e.deltaMode === 1 ? 16 : 1
      if (horizontal) axis.pan((e.shiftKey && e.deltaX === 0 ? e.deltaY : e.deltaX) * scale)
      else axis.zoom(axis.plotWidth / 2, zoomFactor(e.deltaY * scale))
      onChange()
    }
    cv.addEventListener('wheel', wheel, { passive: false })
    cv.addEventListener('pointerdown', down)
    cv.addEventListener('pointermove', move)
    cv.addEventListener('pointerup', up)
    cv.addEventListener('pointercancel', up)
    return () => {
      cv.removeEventListener('wheel', wheel)
      cv.removeEventListener('pointerdown', down)
      cv.removeEventListener('pointermove', move)
      cv.removeEventListener('pointerup', up)
      cv.removeEventListener('pointercancel', up)
    }
  }, [renderer, axis, onChange])

  return <canvas className="minimap" ref={canvas} style={{ height }} />
}

/** The focus row over the whole run, as an image (utilization or lane busy fraction). */
function renderSeries(r: TimelineRenderer, key: string | null, n: number, cpp: number,
  area: string, line: string, dpr: number, h: number): HTMLCanvasElement | null {
  const row = r.model.rows.find((x) => x.key === key)
  if (!row || row.notRecorded) return null
  const values = new Float64Array(n + 1)
  let max = 1
  if (row.kind === 'resource') {
    const info = r.res[row.id]
    if (info.levelRow < 0) return null
    sampleBins(r.trace.levels, info.levelRow, 0, cpp, n, values, new Float64Array(n + 1))
    max = info.ceiling ?? 0
    if (!(max > 0)) for (let p = 0; p < n; p++) max = Math.max(max, values[p])
  } else if (row.kind === 'fabric') {
    // The fabric node's MAX series: the busiest port's average fraction of ceiling.
    const fr = r.trace.fabricRow.get(r.source.fabrics[row.id].path)
    const fl = r.trace.levels.fabric
    if (fr === undefined || !fl) return null
    sampleFabric(fl, fr, 0, cpp, n, values, new Float64Array(n + 1), null)
    max = 1
  } else if (row.kind === 'lane') {
    laneBusy(r.trace.lanes, row.id, 0, cpp, n, values)
    max = 1
  } else return null
  const img = document.createElement('canvas')
  img.width = Math.max(1, Math.round(n * dpr))
  img.height = Math.round(h * dpr)
  const ctx = img.getContext('2d') as CanvasRenderingContext2D
  ctx.scale(dpr, dpr)
  ctx.fillStyle = area
  ctx.globalAlpha = 0.25
  for (let p = 0; p < n; p++) {
    const v = Math.min(1, values[p] / (max || 1))
    ctx.fillRect(p, h - v * h, 1, v * h)
  }
  ctx.globalAlpha = 1
  ctx.fillStyle = line
  for (let p = 0; p < n; p++) {
    const v = Math.min(1, values[p] / (max || 1))
    ctx.fillRect(p, h - v * h - 1, 1, 1.5)
  }
  return img
}
