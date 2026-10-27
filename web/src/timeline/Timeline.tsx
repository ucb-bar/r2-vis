import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChargeCache } from '../data/charges'
import type { WorkerPool } from '../data/pool'
import type { Trace } from '../data/trace'
import type { BlockSelection } from '../state/blocks'
import type { Store } from '../state/store'
import type { FocusTime } from '../state/focus'
import { scopeMasks, taskBar } from '../state/focusqueries'
import type { ViewStore } from '../state/viewstore'
import { clearPrefs, loadPrefs, prefsKey, savePrefs } from '../state/viewprefs'
import { onThemeChange, readTheme } from '../theme/theme'
import { BlocksPanel } from '../ui/BlocksPanel'
import { Section, Sidebar, Subhead } from '../ui/Sidebar'
import { OTHER } from './colors'
import { Minimap } from './Minimap'
import { Tooltip, type TipContent } from '../ui/Tooltip'
import { taskName } from '../data/labels'
import { short } from '../ui/format'
import { linkFor } from '../source/links'
import { AXIS, GUTTER, MAX_SMOOTH, MODE_NAME, TimelineRenderer, type AttributeTo } from './renderer'
import { DRAG_PX, TimeInput } from './timeinput'

interface Props {
  trace: Trace
  charges: ChargeCache
  pool: WorkerPool
  store: ViewStore
  /** the nodes this timeline shows (its area's) */
  blocks: BlockSelection
  /** requests to show a task here (routed to this area by the workbench) */
  reveal: Store<number | null>
  /** this timeline handles the keyboard (Esc, Delete) */
  isKeyTarget: () => boolean
  /** Receives the renderer (the Instant scrubber shows its minimap). */
  onRenderer?: (renderer: TimelineRenderer | null) => void
}

const EDGE_PX = 3
const FLIGHTLINES_KEY = 'r2vis.flightlines'

/** The most flightlines (views-design 7), kept in the browser; 32 by default. */
function loadFlightlines(): number {
  try {
    const n = Number(localStorage.getItem(FLIGHTLINES_KEY))
    return n >= 1 && n <= 128 ? n : 32
  } catch {
    return 32
  }
}
const ATTRIBUTE_TO_KEY = 'r2vis.attributeTo'
const ATTRIBUTE_TO: AttributeTo[] = ['auto', 'task', 'laneKind', 'kind']

/** What a flightline goes to (views-design 7), kept in the browser; auto by default. */
function loadAttributeTo(): AttributeTo {
  try {
    const v = localStorage.getItem(ATTRIBUTE_TO_KEY) as AttributeTo
    return ATTRIBUTE_TO.includes(v) ? v : 'auto'
  } catch {
    return 'auto'
  }
}
const USAGE_KEY = 'r2vis.usage'

/** The usage of selected tasks (views-design 7.1) is shown, kept in the browser; on by default. */
function loadUsage(): boolean {
  try {
    return localStorage.getItem(USAGE_KEY) !== 'off'
  } catch {
    return true
  }
}
const CONTROL_KEY = 'r2vis.controlTraffic'

/** Control traffic is attributed (views-design 7.1), kept in the browser; off by default. */
function loadControl(): boolean {
  try {
    return localStorage.getItem(CONTROL_KEY) === 'on'
  } catch {
    return false
  }
}
const REVEAL_MIN_SPAN = 20_000  // cycles shown at least when a task is revealed

type Drag =
  | { kind: 'resize'; key: string; y0: number; h0: number }
  | { kind: 'label'; row: number; x0: number; y0: number; moved: boolean; additive: boolean; alt: boolean }
  | { kind: 'group'; row: number; button: number; x0: number; y0: number }

/** A context menu: a group header's hidden rows, or a task of an RV program (its source). */
type Menu =
  | { x: number; y: number; kind: 'group'; node: number; items: { key: string; label: string }[] }
  | { x: number; y: number; kind: 'task'; task: number; missing: string | null }

/** The timeline view. Input:
 * - wheel scrolls the rows; ctrl+wheel (trackpad pinch, ctrl+mouse wheel) zooms around the
 *   cursor; horizontal scroll or shift+wheel pans;
 * - left-drag on a plot or the axis selects a range; a click on a plot or Esc clears it;
 * - a click on the axis pins the cursor there; the playhead handle drags the pin (scrub);
 * - right-drag on a plot zooms to the range;
 * - a click on a row label selects the row (ctrl or shift adds); Delete or Backspace hides
 *   the selected rows; dragging a label moves the row inside its node group; dragging a
 *   row's lower edge in the labels resizes it (double-click resets);
 * - a click on a group header collapses it; a right-click lists its hidden rows;
 * - a right-click on a task of an RV program offers its source (Show source). */
export function Timeline({ trace, charges, pool, store, blocks, reveal, isKeyTarget, onRenderer }: Props) {
  const scroller = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const prefsKeyRef = useRef(prefsKey(trace.manifest))
  const [renderer] = useState(() => new TimelineRenderer(trace, charges, pool, blocks, readTheme(),
    loadPrefs(prefsKeyRef.current)))
  const [contentHeight, setContentHeight] = useState(renderer.model.height + AXIS)
  // The scroller's height as last laid out (the spacer under the sticky canvas uses it).
  const [viewHeight, setViewHeight] = useState(0)
  const [tip, setTip] = useState<{ x: number; y: number; content: TipContent } | null>(null)
  const [menu, setMenu] = useState<Menu | null>(null)
  const [smoothing, setSmoothing] = useState(renderer.smoothing)
  const [showAll, setShowAll] = useState(false)
  const [blocksOpen, setBlocksOpen] = useState(false)
  const [flightlines, setFlightlines] = useState(loadFlightlines)
  const [attributeTo, setAttributeTo] = useState(loadAttributeTo)
  const [usage, setUsage] = useState(loadUsage)
  const [control, setControl] = useState(loadControl)
  const [mapVersion, setMapVersion] = useState(0)
  const [scope, setScope] = useState<number[]>([])
  const frame = useRef(0)
  const requestRef = useRef<() => void>(() => {})

  const request = useCallback(() => requestRef.current(), [])
  const refresh = useCallback(() => {
    setContentHeight(renderer.model.height + AXIS)
    setMapVersion((v) => v + 1)
    request()
  }, [renderer, request])

  useEffect(() => {
    onRenderer?.(renderer)
    return () => onRenderer?.(null)
  }, [renderer, onRenderer])

  useEffect(() => {
    const el = scroller.current as HTMLDivElement
    const cv = canvas.current as HTMLCanvasElement
    const ctx = cv.getContext('2d', { alpha: false }) as CanvasRenderingContext2D
    let dpr = window.devicePixelRatio || 1

    const draw = () => {
      frame.current = 0
      if (el.clientWidth === 0) return  // hidden tab: drawn again when shown (resize)
      renderer.scrollY = el.scrollTop
      renderer.draw(ctx, dpr)
    }
    requestRef.current = () => {
      if (!frame.current) frame.current = requestAnimationFrame(draw)
    }
    const offCharges = charges.subscribe(request)
    renderer.deps.onReady = () => { request(); updateTip() }
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
    store.smoothing.set(renderer.smoothing)
    const offSmoothing = store.smoothing.subscribe((v) => {
      if (v !== renderer.smoothing) renderer.setSmoothing(v)
      setSmoothing(renderer.smoothing)
      request()
    })
    // The window set by another view of the store (the Instant scrubber).
    const offWindow = store.window.subscribe((w) => { if (renderer.axis.showWindow(w.a, w.b)) request() })
    // The focus: its time (the range band or the playhead), tasks (drawn selected; their
    // nodes added to this timeline's node set) and resources (their rows selected).
    const applyTime = (t: FocusTime | null) => {
      renderer.selection = t && 'a' in t ? { a: t.a, b: t.b } : null
      renderer.pinned = t && 't' in t ? t.t : null
      request()
    }
    const applyFocus = () => {
      const f = store.focus.get()
      const tasks = f.tasks ?? []
      if (renderer.focusTasks !== f.tasks || renderer.usageTasks.size !== (f.fixed.has('tasks') ? tasks.length : 0)) {
        renderer.focusTasks = f.tasks
        renderer.selectedTasks = new Set(tasks)
        // usage (bands, arrows): only for the tasks a gesture set
        renderer.usageTasks = f.fixed.has('tasks') ? renderer.selectedTasks : new Set()
        const lane = trace.facts.tasks.cols.lane as Int32Array
        const add = new Set<number>()
        for (const t of tasks) {
          const node = trace.dims.lanes[lane[t]]?.node as number | undefined
          if (node !== undefined && !blocks.has(node)) add.add(node)
        }
        if (add.size) blocks.setAll([...add], true)
      }
      renderer.focusResources = new Set(f.resources ?? [])
      renderer.resourcesFixed = f.fixed.has('resources')
      request()
      updateTip()
    }
    renderer.onAttribution = () => { request(); updateTip() }
    renderer.onUsage = () => request()
    renderer.maxFlightlines = loadFlightlines()
    renderer.attributeTo = loadAttributeTo()
    renderer.showUsage = loadUsage()
    renderer.controlTraffic = loadControl()
    const unsubscribe = blocks.subscribe(() => {
      renderer.rebuild()
      renderer.onPrefs?.()
      refresh()
    })

    // Show a task from another view: its node in the timeline and expanded, the view
    // zoomed to it, its lane scrolled into view, the task selected. Applied when the
    // timeline has a size (it may be in a hidden workspace when the request comes, or the
    // request may come before this timeline was mounted).
    let revealPending: number | null = reveal.get()
    const applyReveal = () => {
      const task = revealPending
      if (task === null || el.clientHeight === 0) return
      revealPending = null
      reveal.set(null)  // done: a later mount does not show it again
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
      store.focus.set({ tasks: [task] })
      request()
    }
    const offReveal = reveal.subscribe((task) => {
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
      const content = renderer.tooltip()
      const h = renderer.hover
      setTip(content && h ? { x: h.x, y: h.y, content } : null)
    }
    const setHover = (x: number, y: number) => {
      renderer.hover = { x, y, row: renderer.rowAtY(y), t: renderer.timeAtX(x) }
    }
    applyTime(store.time)
    applyFocus()
    const offTime = store.onTime(applyTime)
    const offFocus = store.focus.subscribe(applyFocus)
    // The attribution scope (global): the flightlines count only owners inside it.
    const applyScope = (s: ReadonlySet<number>) => {
      renderer.attributionScope = scopeMasks(trace, s)
      renderer.scopeKey = [...s].sort((a, b) => a - b).join(',')
      setScope([...s])
      request()
    }
    applyScope(store.scope.get())
    const offScope = store.scope.subscribe(applyScope)

    // Focus gestures (state/focusctl.ts; alt keeps the other fixed parts). A click on a task
    // bar selects that task and the instant there, shift (or ctrl, cmd) + click adds or
    // removes it; a double click selects the task and its bar's range. A click elsewhere
    // selects an instant and a drag a range: on a resource row's line together with its
    // resources (their occupants are then derived), else alone. A right click on a group
    // header lists its hidden rows.
    const time = new TimeInput({
      axis: renderer.axis, store,
      changed: () => { request(); updateTip() },
      time: (t, at) => {
        const i = at.y0 >= AXIS ? renderer.rowAtY(at.y0) : -1
        const res = i >= 0 ? renderer.rowResources(renderer.model.rows[i]) : null
        if (res) {
          renderer.focusKey = renderer.model.rows[i].key
          store.focus.set({ resources: res, time: t }, { keep: at.alt, origin: 'timeline' })
        } else store.focus.set({ time: t }, { keep: at.alt, origin: 'timeline' })
      },
      plotClick: (x, y, e) => {
        setHover(x, y)
        const task = renderer.hoveredTask()
        if (task < 0) return false
        let tasks = [task]
        if (e.shiftKey || e.metaKey || e.ctrlKey) {
          const cur = new Set(store.focus.get().tasks ?? [])
          if (cur.has(task)) cur.delete(task)
          else cur.add(task)
          tasks = [...cur]
        }
        const t = Math.max(0, Math.min(trace.manifest.end_time, renderer.timeAtX(x)))
        store.focus.set({ tasks, time: { t } }, { keep: e.altKey, origin: 'timeline' })
        return true
      },
      plotRightClick: (x, y) => {
        setHover(x, y)
        const task = renderer.hoveredTask()
        const at = task >= 0 ? linkFor(trace, store.sourceMaps.get()).locate(task) : null
        if (at) {
          setMenu({ x, y: y + el.scrollTop, kind: 'task', task, missing: 'missing' in at ? at.missing : null })
          return
        }
        const i = renderer.rowAtY(y)
        if (i >= 0 && renderer.model.rows[i].kind === 'group') openMenu(renderer.model.rows[i].id, x, y)
      },
    })

    const onWheel = (e: WheelEvent) => {
      const { x } = pos(e)
      if (!time.wheel(e, x, el.clientHeight)) return  // native vertical scroll of the rows
      e.preventDefault()
      if (renderer.hover) renderer.hover.t = renderer.timeAtX(renderer.hover.x)
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
            : e.button === 0 ? { kind: 'label', row: i, x0: x, y0: y, moved: false, additive: e.ctrlKey || e.metaKey || e.shiftKey, alt: e.altKey } : null
        }
      } else if (time.down(e, x, y)) {
        el.setPointerCapture(e.pointerId)
        return
      }
      if (drag) el.setPointerCapture(e.pointerId)
    }

    const onMove = (e: PointerEvent) => {
      if ((e.target as Element).closest('.menu')) return
      const { x, y } = pos(e)
      setHover(x, y)
      if (time.move(x)) {
        setTip(null)
        return
      }
      if (!drag) {
        cv.style.cursor = (x < GUTTER && edgeRow(y) >= 0 ? 'ns-resize' : time.cursorAt(x, y)) ?? 'default'
        request()
        updateTip()
        return
      }
      if (drag.kind === 'resize') {
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
      const { x, y } = pos(e)
      if (time.up(e, x, y)) {
        refresh()
        return
      }
      const d = drag
      drag = null
      if (!d) return
      if (d.kind === 'resize') {
        renderer.commitHeights()
      } else if (d.kind === 'label') {
        const row = renderer.model.rows[d.row]
        if (d.moved) {
          const target = renderer.reorder
          renderer.reorder = null
          if (target) renderer.moveRow(target.from, target.before)
        } else if (row.kind === 'fabric' && x < 10 + row.depth * 12 + 8) {
          renderer.toggleFabric(row.key)  // the triangle opens or closes a fabric node
        } else selectRow(d.row, d.additive, d.alt)
      } else if (d.kind === 'group') {
        const row = renderer.model.rows[d.row]
        if (d.button === 0) renderer.toggle(row.id)
        else openMenu(row.id, x, y)
      }
      refresh()
    }

    /** A click on a row's label: a resource row selects its resources in the focus, with
     * the focus time kept (`additive` adds or removes them); another row is selected in
     * this timeline only (for Delete). */
    const selectRow = (i: number, additive: boolean, alt: boolean) => {
      const row = renderer.model.rows[i]
      renderer.focusKey = row.key
      const res = renderer.rowResources(row)
      if (res) {
        const f = store.focus.get()
        let next = res
        if (additive) {
          const cur = new Set(f.resources ?? [])
          const on = res.every((r) => cur.has(r))
          for (const r of res) { if (on) cur.delete(r); else cur.add(r) }
          next = [...cur]
        }
        store.focus.set({ resources: next, ...(f.time ? { time: f.time } : {}) }, { keep: alt, origin: 'timeline' })
        return
      }
      if (!additive) renderer.selectedRows.clear()
      if (additive && renderer.selectedRows.has(row.key)) renderer.selectedRows.delete(row.key)
      else renderer.selectedRows.add(row.key)
    }

    const openMenu = (node: number, x: number, y: number) => {
      setMenu({ x, y: y + el.scrollTop, kind: 'group', node, items: renderer.hiddenOf(node) })
    }

    const onDouble = (e: MouseEvent) => {
      const { x, y } = pos(e)
      if (time.double(x, y)) return
      if (x >= GUTTER) {
        // a task: the task and its bar's range
        setHover(x, y)
        const task = renderer.hoveredTask()
        if (task >= 0) store.focus.set({ tasks: [task], time: taskBar(trace, task) }, { keep: e.altKey, origin: 'timeline' })
        return
      }
      if (x >= GUTTER) return
      const i = edgeRow(y)
      if (i < 0) return
      renderer.setHeight(renderer.model.rows[i].key, null)
      renderer.commitHeights()
      refresh()
    }
    const onLeave = () => {
      renderer.hover = null
      request()
      setTip(null)
    }
    const onKey = (e: KeyboardEvent) => {
      if (!isKeyTarget()) return
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
      if (e.key === 'Escape') {
        // Esc (the workspace clears the focus) clears the zoom box and the row selection.
        renderer.selectedRows.clear()
        renderer.zoomBox = null
        setMenu(null)
        request()
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && renderer.hasRowsToHide()) {
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
      offTime()
      offFocus()
      offScope()
      offWindow()
      offReveal()
      offCharges()
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
  }, [renderer, charges, blocks, reveal, isKeyTarget, store, request, refresh])

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
              <Tooltip tip={tip.content} style={{ left: tip.x > renderer.width - 440 ? undefined : tip.x + 14,
                right: tip.x > renderer.width - 440 ? renderer.width - tip.x + 14 : undefined,
                top: tip.y + 14 + (scroller.current?.scrollTop ?? 0) }} />
            )}
            {menu?.kind === 'task' && (
              <div className="menu" style={{ left: menu.x, top: menu.y }} onPointerDown={(e) => e.stopPropagation()}>
                <div className="menu-title">{taskName(trace, menu.task)}</div>
                <button className="menu-item" onClick={() => { store.showSource.set(menu.task); setMenu(null) }}>
                  {menu.missing === null ? 'Show source' : `Open the source map of ${menu.missing}`}
                </button>
              </div>
            )}
            {menu?.kind === 'group' && (
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
          <Section title="View" view="timeline">
            <label className="tool">
              smoothing
              <input type="range" min={1} max={MAX_SMOOTH} value={smoothing}
                onChange={(e) => store.smoothing.set(Number(e.target.value))} />
              <span className="tool-value">{smoothing === 1 ? 'off' : `${smoothing} px`}</span>
            </label>
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
          <Section title="Dependencies" view="timeline">
            <label className="tool">
              <input type="checkbox" checked={showAll}
                onChange={(e) => { renderer.showAllDeps = e.target.checked; setShowAll(e.target.checked); request() }} />
              show all dependencies
            </label>
          </Section>
          <Section title="Attribution" view="timeline">
            {scope.length > 0 && (
              <span className="chip scope-chip">scope: {scope.map((n) => short(String(trace.dims.nodes[n]?.path ?? n))).join(', ')}
                <button className="chip-x" aria-label="clear the scope" onClick={() => store.scope.set(new Set())}>×</button></span>
            )}
            <label className="tool">
              flightlines
              <input type="range" min={1} max={128} value={flightlines}
                onChange={(e) => {
                  const n = Number(e.target.value)
                  renderer.maxFlightlines = n
                  setFlightlines(n)
                  try { localStorage.setItem(FLIGHTLINES_KEY, String(n)) } catch { /* not kept */ }
                  request()
                }} />
              <span className="tool-value">{flightlines}</span>
            </label>
            <label className="tool">
              attribute to
              <select value={attributeTo}
                onChange={(e) => {
                  const v = e.target.value as AttributeTo
                  renderer.attributeTo = v
                  setAttributeTo(v)
                  try { localStorage.setItem(ATTRIBUTE_TO_KEY, v) } catch { /* not kept */ }
                  request()
                }}>
                {ATTRIBUTE_TO.map((v) => <option key={v} value={v}>{v === 'auto' ? 'auto' : MODE_NAME[v]}</option>)}
              </select>
            </label>
            <label className="tool">
              <input type="checkbox" checked={usage}
                onChange={(e) => {
                  const on = e.target.checked
                  renderer.showUsage = on
                  setUsage(on)
                  try { localStorage.setItem(USAGE_KEY, on ? 'on' : 'off') } catch { /* not kept */ }
                  request()
                }} />
              usage of selected tasks
            </label>
            <label className="tool">
              <input type="checkbox" checked={control}
                onChange={(e) => {
                  const on = e.target.checked
                  renderer.controlTraffic = on
                  setControl(on)
                  try { localStorage.setItem(CONTROL_KEY, on ? 'on' : 'off') } catch { /* not kept */ }
                  request()
                }} />
              control &amp; Neutrino work
            </label>
          </Section>
          {blocksOpen && (
            <Section title="Blocks" view="timeline">
              <BlocksPanel nodes={trace.dims.nodes} blocks={blocks} onClose={() => setBlocksOpen(false)} />
            </Section>
          )}
          <Section title="Legend" view="timeline">
            <Subhead>tasks by kind</Subhead>
            <Legend renderer={renderer} />
            <Subhead>lines</Subhead>
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
    </div>
  )
}

const LINE_FAMILIES: [string, string][] = [
  ['global-2', 'global fabric'], ['local-0', 'local fabric'],
  ['control-2', 'control fabric'], ['tensor', 'tensor arrays'],
  ['vector', 'vector arrays'], ['scalar', 'Neutrino scalar'],
]

function LineLegend() {
  return (
    <div className="legend">
      {LINE_FAMILIES.map(([slot, name]) => (
        <span key={slot} className="legend-item">
          <span className="swatch line" style={{ background: `var(--line-${slot})` }} />{name}
        </span>
      ))}
      <span className="legend-item"><span className="swatch line dotted" />ceiling</span>
    </div>
  )
}

