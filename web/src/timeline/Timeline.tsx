import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChargeCache } from '../data/charges'
import type { WorkerPool } from '../data/pool'
import type { Trace } from '../data/trace'
import { sameRange, toggleTask, type ViewStore } from '../state/viewstore'
import { clearPrefs, loadPrefs, prefsKey, savePrefs } from '../state/viewprefs'
import { onThemeChange, readTheme } from '../theme/theme'
import { BlocksPanel } from '../ui/BlocksPanel'
import { Section, Sidebar } from '../ui/Sidebar'
import { OTHER } from './colors'
import { Minimap } from './Minimap'
import { AXIS, GUTTER, MAX_SMOOTH, TimelineRenderer } from './renderer'
import { zoomFactor } from './viewport'

interface Props {
  trace: Trace
  charges: ChargeCache
  pool: WorkerPool
  store: ViewStore
  docked: boolean
  onDock: (docked: boolean) => void
}

declare global {
  interface Window { __r2timeline?: TimelineRenderer }
}

const DRAG_PX = 3
const EDGE_PX = 3
const REVEAL_MIN_SPAN = 20_000  // cycles shown at least when a task is revealed

type Drag =
  | { kind: 'select' | 'zoom'; x0: number; t0: number; moved: boolean; row: number }
  | { kind: 'resize'; key: string; y0: number; h0: number }
  | { kind: 'label'; row: number; x0: number; y0: number; moved: boolean; additive: boolean }
  | { kind: 'group'; row: number; button: number; x0: number; y0: number }

interface Menu {
  x: number
  y: number
  node: number
  items: { key: string; label: string }[]
}

/** The timeline view. Input:
 * - wheel scrolls the rows; ctrl+wheel (trackpad pinch, ctrl+mouse wheel) zooms around the
 *   cursor; horizontal scroll or shift+wheel pans;
 * - left-drag on a plot selects a range; a click on a plot or Esc clears it;
 * - right-drag on a plot zooms to the range;
 * - a click on a row label selects the row (ctrl or shift adds); Delete or Backspace hides
 *   the selected rows; dragging a label moves the row inside its node group; dragging a
 *   row's lower edge in the labels resizes it (double-click resets);
 * - a click on a group header collapses it; a right-click lists its hidden rows. */
export function Timeline({ trace, charges, pool, store, docked, onDock }: Props) {
  const blocks = store.blocks
  const scroller = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const prefsKeyRef = useRef(prefsKey(trace.manifest))
  const [renderer] = useState(() => new TimelineRenderer(trace, charges, pool, blocks, readTheme(),
    loadPrefs(prefsKeyRef.current)))
  const [contentHeight, setContentHeight] = useState(renderer.model.height + AXIS)
  // The scroller's height as last laid out (the spacer under the sticky canvas uses it).
  const [viewHeight, setViewHeight] = useState(0)
  const [tip, setTip] = useState<{ x: number; y: number; lines: string[] } | null>(null)
  const [menu, setMenu] = useState<Menu | null>(null)
  const [smoothing, setSmoothing] = useState(renderer.smoothing)
  const [showAll, setShowAll] = useState(false)
  const [blocksOpen, setBlocksOpen] = useState(false)
  const [pinned, setPinned] = useState<number | null>(null)
  const [mapVersion, setMapVersion] = useState(0)
  const frame = useRef(0)
  const requestRef = useRef<() => void>(() => {})

  const request = useCallback(() => requestRef.current(), [])
  const refresh = useCallback(() => {
    setContentHeight(renderer.model.height + AXIS)
    setMapVersion((v) => v + 1)
    request()
  }, [renderer, request])

  useEffect(() => {
    window.__r2timeline = renderer
    const el = scroller.current as HTMLDivElement
    const cv = canvas.current as HTMLCanvasElement
    const ctx = cv.getContext('2d', { alpha: false }) as CanvasRenderingContext2D
    let dpr = window.devicePixelRatio || 1

    const draw = () => {
      frame.current = 0
      renderer.scrollY = el.scrollTop
      renderer.draw(ctx, dpr)
    }
    requestRef.current = () => {
      if (!frame.current) frame.current = requestAnimationFrame(draw)
    }
    charges.onLoad = request
    renderer.deps.onReady = request
    renderer.onPrefs = () => savePrefs(prefsKeyRef.current, renderer.prefs())
    let mapPending = false
    const publishWindow = () => {
      const v = renderer.view
      store.window.set({ a: v.t0, b: v.t0 + renderer.plotWidth * v.cpp, cpp: v.cpp })
    }
    renderer.onView = () => {
      if (mapPending) return
      mapPending = true
      requestAnimationFrame(() => { mapPending = false; setMapVersion((v) => v + 1); publishWindow() })
    }
    const publishRange = () => {
      const r = renderer.selection && renderer.selection.b > renderer.selection.a ? { ...renderer.selection } : null
      if (!sameRange(r, store.range.get())) store.range.set(r)
    }
    store.smoothing.set(renderer.smoothing)
    const offSmoothing = store.smoothing.subscribe((v) => {
      if (v !== renderer.smoothing) renderer.setSmoothing(v)
      setSmoothing(renderer.smoothing)
      request()
    })
    const offRange = store.range.subscribe((r) => {
      if (!sameRange(r, renderer.selection)) { renderer.selection = r ? { ...r } : null; request() }
    })
    renderer.selectedTasks = store.tasks.get()
    const offTasks = store.tasks.subscribe((t) => { renderer.selectedTasks = t; request(); updateTip() })
    const offCursor = store.cursor.subscribe((c) => {
      const p = c?.pinned ? c.t : null
      if (p !== renderer.pinned) { renderer.pinned = p; setPinned(p); request() }
    })
    const unsubscribe = blocks.subscribe(() => {
      renderer.rebuild()
      renderer.onPrefs?.()
      refresh()
    })

    // Show a task from another view: its node in the timeline and expanded, the view
    // zoomed to it, its lane scrolled into view, the task selected. Applied when the
    // timeline has a size (it may be in a hidden tab when the request comes).
    let revealPending: number | null = null
    const applyReveal = () => {
      const task = revealPending
      if (task === null || el.clientHeight === 0) return
      revealPending = null
      const c = trace.facts.tasks.cols
      const lane = (c.lane as Int32Array)[task]
      const nodes = trace.dims.nodes
      const node = trace.dims.lanes[lane]?.node as number | undefined
      if (node !== undefined && !blocks.has(node)) blocks.setChecked(node, true)
      for (let n = node; n !== undefined && n !== null; n = nodes[n].parent as number | undefined) renderer.collapsed.delete(n)
      renderer.rebuild()
      refresh()
      const issue = (c.issue as Float64Array)[task]
      const end = (c.complete as Float64Array)[task]
      const a = issue === issue ? issue : (c.invoke as Float64Array)[task]
      const b = end === end ? Math.max(end, a + 1) : a + 1
      // The view: the task in the middle fifth, at least REVEAL_MIN_SPAN cycles wide.
      const pw = renderer.plotWidth
      const cpp = Math.max(5 * (b - a), REVEAL_MIN_SPAN) / pw
      renderer.setView({ t0: (a + b) / 2 - (pw * cpp) / 2, cpp })
      const ri = renderer.model.rowOfLane[lane]
      if (ri >= 0) el.scrollTop = Math.max(0, renderer.model.top[ri] - (el.clientHeight - AXIS) / 2)
      const sel = new Set(store.tasks.get())
      sel.add(task)
      store.tasks.set(sel)
      request()
    }
    const offReveal = store.reveal.subscribe((task) => {
      if (task === null) return
      revealPending = task
      applyReveal()
    })

    const resize = () => {
      dpr = window.devicePixelRatio || 1
      const w = el.clientWidth
      const h = el.clientHeight
      if (w === 0 || h === 0) return  // hidden tab: keep the view
      cv.width = Math.round(w * dpr)
      cv.height = Math.round(h * dpr)
      cv.style.width = `${w}px`
      cv.style.height = `${h}px`
      renderer.resize(w, h)
      setViewHeight(h)
      applyReveal()
      request()
    }
    const ro = new ResizeObserver(resize)
    ro.observe(el)
    resize()

    const pos = (e: MouseEvent) => {
      const rect = cv.getBoundingClientRect()
      return { x: e.clientX - rect.left, y: e.clientY - rect.top }
    }
    const updateTip = () => {
      const lines = renderer.tooltip()
      const h = renderer.hover
      setTip(lines && h ? { x: h.x, y: h.y, lines } : null)
    }
    const setHover = (x: number, y: number) => {
      renderer.hover = { x, y, row: renderer.rowAtY(y), t: renderer.timeAtX(x) }
      store.hover(x >= GUTTER ? renderer.hover.t : null)
    }

    const onWheel = (e: WheelEvent) => {
      const { x } = pos(e)
      const horizontal = !e.ctrlKey && (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY))
      if (!horizontal && !e.ctrlKey) return  // native vertical scroll of the rows
      e.preventDefault()
      const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1
      if (horizontal) renderer.pan((e.shiftKey && e.deltaX === 0 ? e.deltaY : e.deltaX) * scale)
      else renderer.zoom(Math.max(0, x - GUTTER), zoomFactor(e.deltaY * scale))
      if (renderer.hover) renderer.hover.t = renderer.timeAtX(renderer.hover.x)
      request()
      updateTip()
    }

    let drag: Drag | null = null

    /** Resize target: the row whose lower edge is within EDGE_PX of y (labels only). */
    const edgeRow = (y: number): number => {
      const i = renderer.rowAtY(y)
      if (i < 0) return -1
      const top = renderer.rowTop(i)
      const row = renderer.model.rows[i]
      if (top + row.height - y <= EDGE_PX && row.kind !== 'group') return i
      if (y - top <= EDGE_PX - 1 && i > 0 && renderer.model.rows[i - 1].kind !== 'group') return i - 1
      return -1
    }

    const onDown = (e: PointerEvent) => {
      if ((e.target as Element).closest('.menu')) return
      setMenu(null)
      const { x, y } = pos(e)
      if (e.button !== 0 && e.button !== 2) return
      if (x < GUTTER) {
        const edge = e.button === 0 ? edgeRow(y) : -1
        if (edge >= 0) {
          const row = renderer.model.rows[edge]
          drag = { kind: 'resize', key: row.key, y0: y, h0: row.height }
        } else {
          const i = renderer.rowAtY(y)
          if (i < 0) return
          const row = renderer.model.rows[i]
          drag = row.kind === 'group'
            ? { kind: 'group', row: i, button: e.button, x0: x, y0: y }
            : e.button === 0 ? { kind: 'label', row: i, x0: x, y0: y, moved: false, additive: e.ctrlKey || e.metaKey || e.shiftKey } : null
        }
      } else {
        drag = { kind: e.button === 0 ? 'select' : 'zoom', x0: x, t0: renderer.timeAtX(x), moved: false, row: renderer.rowAtY(y) }
      }
      if (drag) el.setPointerCapture(e.pointerId)
    }

    const onMove = (e: PointerEvent) => {
      if ((e.target as Element).closest('.menu')) return
      const { x, y } = pos(e)
      setHover(x, y)
      if (!drag) {
        cv.style.cursor = x < GUTTER && edgeRow(y) >= 0 ? 'ns-resize' : 'default'
        request()
        updateTip()
        return
      }
      if (drag.kind === 'select' || drag.kind === 'zoom') {
        if (!drag.moved && Math.abs(x - drag.x0) <= DRAG_PX) return
        drag.moved = true
        const r = { a: drag.t0, b: renderer.timeAtX(Math.max(GUTTER, Math.min(renderer.width, x))) }
        if (drag.kind === 'select') {
          renderer.selection = { a: Math.min(r.a, r.b), b: Math.max(r.a, r.b) }
          publishRange()
        } else renderer.zoomBox = r
        setTip(null)
      } else if (drag.kind === 'resize') {
        renderer.setHeight(drag.key, drag.h0 + (y - drag.y0))
        setContentHeight(renderer.model.height + AXIS)
      } else if (drag.kind === 'label') {
        if (!drag.moved && Math.abs(y - drag.y0) <= DRAG_PX + 1) return
        drag.moved = true
        renderer.reorder = reorderTarget(renderer, drag.row, y)
      }
      request()
    }

    const onUp = (e: PointerEvent) => {
      const d = drag
      drag = null
      if (!d) return
      const { x, y } = pos(e)
      if (d.kind === 'select') {
        if (!d.moved && e.altKey) store.pin(renderer.timeAtX(x))  // alt+click pins the cursor time
        else if (!d.moved) {
          // A click toggles the task under it; on empty space it clears the tasks, then the range.
          setHover(x, y)
          const task = renderer.hoveredTask()
          if (task >= 0) toggleTask(store, task)
          else if (store.tasks.get().size) store.tasks.set(new Set())
          else renderer.selection = null
        } else if (renderer.selection && renderer.selection.b - renderer.selection.a <= 0) renderer.selection = null
        publishRange()
      } else if (d.kind === 'zoom') {
        if (d.moved && renderer.zoomBox) renderer.zoomTo(renderer.zoomBox)
        else if (d.row >= 0 && renderer.model.rows[d.row].kind === 'group') openMenu(renderer.model.rows[d.row].id, x, y)
        renderer.zoomBox = null
      } else if (d.kind === 'resize') {
        renderer.commitHeights()
      } else if (d.kind === 'label') {
        const row = renderer.model.rows[d.row]
        if (d.moved) {
          const target = renderer.reorder
          renderer.reorder = null
          if (target) renderer.moveRow(target.from, target.before)
        } else if (row.kind === 'fabric' && x < 10 + row.depth * 12 + 8) {
          renderer.toggleFabric(row.key)  // the triangle opens or closes a fabric node
        } else {
          if (!d.additive) renderer.selectedRows.clear()
          if (d.additive && renderer.selectedRows.has(row.key)) renderer.selectedRows.delete(row.key)
          else renderer.selectedRows.add(row.key)
          renderer.focusKey = row.key
        }
      } else if (d.kind === 'group') {
        const row = renderer.model.rows[d.row]
        if (d.button === 0) renderer.toggle(row.id)
        else openMenu(row.id, x, y)
      }
      refresh()
    }

    const openMenu = (node: number, x: number, y: number) => {
      setMenu({ x, y: y + el.scrollTop, node, items: renderer.hiddenOf(node) })
    }

    const onDouble = (e: MouseEvent) => {
      const { x, y } = pos(e)
      if (x >= GUTTER) return
      const i = edgeRow(y)
      if (i < 0) return
      renderer.setHeight(renderer.model.rows[i].key, null)
      renderer.commitHeights()
      refresh()
    }
    const onLeave = () => {
      renderer.hover = null
      store.hover(null)
      request()
      setTip(null)
    }
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
      if (e.key === 'Escape') {
        // Esc clears the task selection first, then the range.
        if (store.tasks.get().size) store.tasks.set(new Set())
        else {
          renderer.selection = null
          publishRange()
        }
        renderer.zoomBox = null
        setMenu(null)
        request()
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && renderer.selectedRows.size) {
        e.preventDefault()
        renderer.hideSelected()
        refresh()
      }
    }
    const theme = onThemeChange(() => { renderer.theme = readTheme(); refresh() })
    const noMenu = (e: Event) => e.preventDefault()
    el.addEventListener('wheel', onWheel, { passive: false })
    el.addEventListener('scroll', request)
    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onUp)
    el.addEventListener('dblclick', onDouble)
    el.addEventListener('mouseleave', onLeave)
    el.addEventListener('contextmenu', noMenu)
    window.addEventListener('keydown', onKey)
    return () => {
      ro.disconnect()
      theme()
      unsubscribe()
      offSmoothing()
      offRange()
      offCursor()
      offTasks()
      offReveal()
      charges.onLoad = null
      renderer.deps.onReady = null
      renderer.onPrefs = null
      renderer.onView = null
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('scroll', request)
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onUp)
      el.removeEventListener('dblclick', onDouble)
      el.removeEventListener('mouseleave', onLeave)
      el.removeEventListener('contextmenu', noMenu)
      window.removeEventListener('keydown', onKey)
      if (frame.current) cancelAnimationFrame(frame.current)
      frame.current = 0
    }
  }, [renderer, charges, blocks, store, request, refresh])

  const restore = (keys: string[]) => {
    renderer.restore(keys)
    setMenu(null)
    refresh()
  }

  return (
    <div className="timeline">
      <div className="timeline-body">
        <div className="tl-main">
          <div className="tl-scroll" ref={scroller}>
            <canvas className="tl-canvas" ref={canvas} />
            <div style={{ height: Math.max(0, contentHeight - viewHeight) }} />
            {tip && (
              <div className="tooltip" style={{ left: tip.x + 14, top: tip.y + 14 + (scroller.current?.scrollTop ?? 0) }}>
                {tip.lines.map((l, i) => <div key={i} className={i === 0 ? 'tooltip-title' : undefined}>{l}</div>)}
              </div>
            )}
            {menu && (
              <div className="menu" style={{ left: menu.x, top: menu.y }} onPointerDown={(e) => e.stopPropagation()}>
                <div className="menu-title">{String(trace.dims.nodes[menu.node].path)}</div>
                {menu.items.length === 0 && <div className="menu-empty">no hidden rows</div>}
                {menu.items.map((it) => (
                  <button key={it.key} className="menu-item" onClick={() => restore([it.key])}>Show {it.label}</button>
                ))}
                {menu.items.length > 1 && (
                  <button className="menu-item" onClick={() => restore(menu.items.map((it) => it.key))}>Show all</button>
                )}
              </div>
            )}
          </div>
          <Minimap renderer={renderer} version={mapVersion} onChange={request} />
        </div>
        <Sidebar>
          <Section title="Options">
            <label className="tool">
              smoothing
              <input type="range" min={1} max={MAX_SMOOTH} value={smoothing}
                onChange={(e) => store.smoothing.set(Number(e.target.value))} />
              <span className="tool-value">{smoothing === 1 ? 'off' : `${smoothing} px`}</span>
            </label>
            <label className="tool">
              <input type="checkbox" checked={showAll}
                onChange={(e) => { renderer.showAllDeps = e.target.checked; setShowAll(e.target.checked); request() }} />
              show all dependencies
            </label>
            <label className="tool">
              <input type="checkbox" checked={docked} onChange={(e) => onDock(e.target.checked)} />
              dock the instant view below
            </label>
            {pinned !== null && (
              <span className="chip">pinned at {Math.round(pinned).toLocaleString('en-US')}
                <button className="chip-x" aria-label="unpin" onClick={() => store.unpin()}>×</button></span>
            )}
            <div className="tool-row">
              <button className={blocksOpen ? 'button small active' : 'button small'} onClick={() => setBlocksOpen(!blocksOpen)}>Blocks</button>
              <button className="button small" onClick={() => {
                clearPrefs(prefsKeyRef.current)
                renderer.resetView()
                store.smoothing.set(renderer.smoothing)
                refresh()
              }}>Reset view</button>
            </div>
          </Section>
          {blocksOpen && (
            <Section title="Blocks">
              <BlocksPanel nodes={trace.dims.nodes} blocks={blocks} onClose={() => setBlocksOpen(false)} />
            </Section>
          )}
          <Section title="Tasks by kind">
            <Legend renderer={renderer} />
          </Section>
          <Section title="Lines">
            <LineLegend />
          </Section>
        </Sidebar>
      </div>
    </div>
  )
}

/** Where a dragged row would go: before a row of the same container (a node's own rows,
 * or the rows of one fabric node). A fabric node moves with its open rows. */
function reorderTarget(r: TimelineRenderer, from: number, y: number): { from: number; before: number } | null {
  const rows = r.model.rows
  const row = rows[from]
  let i = r.rowAtY(y)
  if (i < 0) i = rows.length - 1
  // Step out of the rows inside other fabric nodes to their fabric row.
  while (i > 0 && rows[i].parent !== row.parent && rows[i].parent.startsWith('f:') && !row.parent.startsWith('f:')) i--
  const sibling = (k: number) => k >= 0 && k < rows.length && rows[k].parent === row.parent && rows[k].kind !== 'group'
  if (!sibling(i)) {
    const first = rows.findIndex((x) => x.parent === row.parent && x.kind !== 'group')
    if (first < 0) return null
    let last = first
    for (let k = first; k < rows.length && (rows[k].parent === row.parent || rows[k].parent.startsWith('f:')); k++) {
      if (rows[k].parent === row.parent) last = k
    }
    return { from, before: y < r.rowTop(first) ? first : last + 1 }
  }
  const top = r.rowTop(i)
  let before = y > top + rows[i].height / 2 ? i + 1 : i
  // Past an open fabric node: after its rows.
  while (before < rows.length && rows[before].parent.startsWith('f:') && rows[before].parent !== row.parent) before++
  return { from, before }
}

function Legend({ renderer }: { renderer: TimelineRenderer }) {
  return (
    <div className="legend">
      {renderer.legend.map((e) => (
        <span key={e.slot} className="legend-item">
          <span className="swatch" style={{ background: e.slot === OTHER ? 'var(--series-other)' : `var(--series-${e.slot + 1})` }} />
          {e.names.join(', ')}
        </span>
      ))}
      <span className="legend-item legend-note">Neutrino tasks: at least a 3 px tick</span>
    </div>
  )
}

const LINE_FAMILIES: [string, string][] = [
  ['global-2', 'global fabric (steps by level)'], ['local-0', 'local fabric'],
  ['control-2', 'control fabric (steps by level)'], ['tensor', 'tensor arrays'],
  ['vector', 'vector arrays'], ['scalar', 'Neutrino scalar, complete'],
]

function LineLegend() {
  return (
    <div className="legend">
      {LINE_FAMILIES.map(([slot, name]) => (
        <span key={slot} className="legend-item">
          <span className="swatch line" style={{ background: `var(--line-${slot})` }} />{name}
        </span>
      ))}
      <span className="legend-item legend-note">dotted: 100 % of the ceiling</span>
    </div>
  )
}

