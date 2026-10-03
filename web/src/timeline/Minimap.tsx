import { useEffect, useRef } from 'react'
import { onThemeChange, readTheme } from '../theme/theme'
import { GUTTER, type TimelineRenderer } from './renderer'
import { laneBusy, sampleBins } from './util'

const HEIGHT = 52
const EDGE_PX = 6

interface Props {
  renderer: TimelineRenderer
  /** Increments when the main view or the focus row changes. */
  version: number
  onChange: () => void
}

/** Minimap and scrollbar: the full-run series of the focus row, with a box for the shown
 * range. Drag the box to pan, drag its edges to zoom, click outside it to center there. */
export function Minimap({ renderer, version, onChange }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const series = useRef<{ key: string | null; width: number; theme: string; image: HTMLCanvasElement | null }>({ key: null, width: 0, theme: '', image: null })

  useEffect(() => onThemeChange(() => { series.current.theme = ''; draw() }), [])

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
    if (cv.width !== Math.round(width * dpr)) {
      cv.width = Math.round(width * dpr)
      cv.height = Math.round(HEIGHT * dpr)
    }
    const ctx = cv.getContext('2d') as CanvasRenderingContext2D
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const row = renderer.focusRow()
    const s = series.current
    const themeKey = th.accent + th.surface
    if (s.key !== (row?.key ?? null) || s.width !== width || s.theme !== themeKey) {
      s.key = row?.key ?? null
      s.width = width
      s.theme = themeKey
      const line = row && (row.kind === 'resource' || row.kind === 'fabric') ? renderer.lineColorOf(row) : th.accent
      s.image = renderSeries(renderer, row?.key ?? null, plot, cpp, line, line, dpr)
    }
    ctx.fillStyle = th.surface
    ctx.fillRect(0, 0, width, HEIGHT)
    ctx.fillStyle = th.axis
    ctx.fillRect(0, 0, width, 1)
    ctx.fillStyle = th.inkMuted
    ctx.font = `${th.fontSizeXs}px ${th.fontSans}`
    ctx.textBaseline = 'middle'
    const label = row ? `${String(renderer.trace.dims.nodes[row.node].path)}.${row.label}` : 'click a row label to show it here'
    ctx.fillText(label.length > 44 ? `…${label.slice(-43)}` : label, 10, HEIGHT / 2)
    if (s.image) ctx.drawImage(s.image, GUTTER, 4, plot, HEIGHT - 8)
    // The box of the shown range.
    const v = renderer.view
    const x0 = GUTTER + v.t0 / cpp
    const x1 = GUTTER + (v.t0 + renderer.plotWidth * v.cpp) / cpp
    const l = Math.max(GUTTER, x0)
    const r = Math.min(width, Math.max(l + 3, x1))
    ctx.fillStyle = th.hover
    ctx.fillRect(GUTTER, 2, l - GUTTER, HEIGHT - 4)
    ctx.fillRect(r, 2, width - r, HEIGHT - 4)
    ctx.strokeStyle = th.ink
    ctx.lineWidth = 1.5
    ctx.strokeRect(l + 0.75, 2.75, r - l - 1.5, HEIGHT - 5.5)
    ctx.fillStyle = th.ink
    ctx.fillRect(l, HEIGHT / 2 - 8, 3, 16)
    ctx.fillRect(r - 3, HEIGHT / 2 - 8, 3, 16)
  }

  useEffect(draw, [version])

  useEffect(() => {
    const cv = canvas.current as HTMLCanvasElement
    let drag: { mode: 'move' | 'left' | 'right'; x0: number; t0: number; t1: number } | null = null
    const span = () => renderer.plotWidth * renderer.view.cpp
    const timeOf = (x: number) => (x - GUTTER) * geometry().cpp
    const down = (e: PointerEvent) => {
      const x = e.offsetX
      if (x < GUTTER || e.button !== 0) return
      const { cpp } = geometry()
      const v = renderer.view
      const x0 = GUTTER + v.t0 / cpp
      const x1 = GUTTER + (v.t0 + span()) / cpp
      cv.setPointerCapture(e.pointerId)
      if (Math.abs(x - x0) <= EDGE_PX) drag = { mode: 'left', x0: x, t0: v.t0, t1: v.t0 + span() }
      else if (Math.abs(x - x1) <= EDGE_PX) drag = { mode: 'right', x0: x, t0: v.t0, t1: v.t0 + span() }
      else if (x > x0 && x < x1) drag = { mode: 'move', x0: x, t0: v.t0, t1: v.t0 + span() }
      else {
        // Center the view on the clicked time.
        renderer.setView({ t0: timeOf(x) - span() / 2, cpp: v.cpp })
        drag = { mode: 'move', x0: x, t0: renderer.view.t0, t1: renderer.view.t0 + span() }
        onChange()
      }
    }
    const move = (e: PointerEvent) => {
      const x = e.offsetX
      if (!drag) {
        const { cpp } = geometry()
        const v = renderer.view
        const x0 = GUTTER + v.t0 / cpp
        const x1 = GUTTER + (v.t0 + span()) / cpp
        cv.style.cursor = x >= GUTTER && (Math.abs(x - x0) <= EDGE_PX || Math.abs(x - x1) <= EDGE_PX) ? 'ew-resize'
          : x > x0 && x < x1 ? 'grab' : 'default'
        return
      }
      const dt = (x - drag.x0) * geometry().cpp
      const pw = renderer.plotWidth
      if (drag.mode === 'move') renderer.setView({ t0: drag.t0 + dt, cpp: renderer.view.cpp })
      else if (drag.mode === 'left') {
        const t0 = Math.min(drag.t0 + dt, drag.t1 - pw / 64)
        renderer.setView({ t0, cpp: (drag.t1 - t0) / pw })
      } else {
        const t1 = Math.max(drag.t1 + dt, drag.t0 + pw / 64)
        renderer.setView({ t0: drag.t0, cpp: (t1 - drag.t0) / pw })
      }
      onChange()
    }
    const up = () => { drag = null }
    cv.addEventListener('pointerdown', down)
    cv.addEventListener('pointermove', move)
    cv.addEventListener('pointerup', up)
    cv.addEventListener('pointercancel', up)
    return () => {
      cv.removeEventListener('pointerdown', down)
      cv.removeEventListener('pointermove', move)
      cv.removeEventListener('pointerup', up)
      cv.removeEventListener('pointercancel', up)
    }
  }, [renderer, onChange])

  return <canvas className="minimap" ref={canvas} style={{ height: HEIGHT }} />
}

/** The focus row over the whole run, as an image (utilization or lane busy fraction). */
function renderSeries(r: TimelineRenderer, key: string | null, n: number, cpp: number,
  area: string, line: string, dpr: number): HTMLCanvasElement | null {
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
    // The fabric node's MAX series: per bin, the largest fraction of ceiling over its ports.
    const fr = r.trace.fabricRow.get(r.source.fabrics[row.id].path)
    const fl = r.trace.levels.fabric
    if (fr === undefined || !fl) return null
    sampleBins(fl, fr, 0, cpp, n, values, new Float64Array(n + 1))
    max = 1
  } else if (row.kind === 'lane') {
    laneBusy(r.trace.lanes, row.id, 0, cpp, n, values)
    max = 1
  } else return null
  const h = 40
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
