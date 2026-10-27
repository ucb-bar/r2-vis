// The areas of one workspace (state/layout.ts): placed side by side as absolute boxes, all
// children of one element, so that a split, a merge or a close does not remount the views
// that stay. Each area has a thin header: its view, split, close, maximize. Its corners
// are action zones (as in Blender): a drag into the area splits it, a drag across an edge
// into the neighbor of the same split joins the two.
import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { BlockView } from '../blocks/BlockView'
import type { ChargeCache } from '../data/charges'
import type { WorkerPool } from '../data/pool'
import type { Trace } from '../data/trace'
import { SourceView } from '../source/SourceView'
import {
  minSize, neighborOf, nodeAt, place, VIEWS, MIN_AREA,
  type AreaLeaf, type Rect, type SplitDir, type ViewType, type WorkspaceDef,
} from '../state/layout'
import type { ViewStore } from '../state/viewstore'
import type { Workbench } from '../state/workbench'
import { Timeline } from '../timeline/Timeline'
import type { TimelineRenderer } from '../timeline/renderer'
import type { OpenSourceMap } from '../App'
import { AreaContext, type AreaApi } from './area'
import { Icon, type IconName } from './icons'
import { InstantView } from './InstantView'
import { Tooltip } from './Tooltip'

/** The gap between areas (CSS px). */
const GAP = 4

export interface Shared {
  trace: Trace
  charges: ChargeCache
  pool: WorkerPool
  store: ViewStore
  bench: Workbench
  source: OpenSourceMap
  onOpenSource: (file: File) => void
}

/** A button with an icon and the shared tooltip under it. */
export function IconButton({ icon, tip, sub, onClick, disabled = false }:
  { icon: IconName; tip: string; sub?: string; onClick: () => void; disabled?: boolean }) {
  const [hover, setHover] = useState(false)
  return (
    <span className="icon-wrap" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <button className="icon-button" aria-label={tip} disabled={disabled}
        onClick={(e) => { e.stopPropagation(); setHover(false); onClick() }}><Icon name={icon} /></button>
      {hover && <Tooltip className="tip-below" tip={{ title: tip, sub, sections: [] }} />}
    </span>
  )
}

/** A small icon inside another control (a tab): a span, with the shared tooltip. */
export function InlineIcon({ icon, tip, onClick }: { icon: IconName; tip: string; onClick: () => void }) {
  const [hover, setHover] = useState(false)
  return (
    <span className="icon-wrap inline" role="button" aria-label={tip} onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)} onClick={(e) => { e.stopPropagation(); onClick() }}>
      <Icon name={icon} size={12} />
      {hover && <Tooltip className="tip-below" tip={{ title: tip, sections: [] }} />}
    </span>
  )
}

/** A rectangle in shares as CSS, less half the gap on the sides that touch another area. */
function rectStyle(r: Rect): CSSProperties {
  const e = 1e-9
  const l = r.x > e ? GAP / 2 : 0
  const rr = r.x + r.w < 1 - e ? GAP / 2 : 0
  const t = r.y > e ? GAP / 2 : 0
  const b = r.y + r.h < 1 - e ? GAP / 2 : 0
  return {
    left: `calc(${r.x * 100}% + ${l}px)`, width: `calc(${r.w * 100}% - ${l + rr}px)`,
    top: `calc(${r.y * 100}% + ${t}px)`, height: `calc(${r.h * 100}% - ${t + b}px)`,
  }
}

/** A corner drag: the area, the corner (its right or bottom side), the start. */
interface Gesture { id: string; rect: Rect; right: boolean; bottom: boolean; x0: number; y0: number }

/** What a corner drag would do on release: a split at a line (refused when a part would be
 * under the minimum size), or a join (the kept area takes the dropped one's space). */
type Preview =
  | { kind: 'split'; dir: SplitDir; ratio: number; ok: boolean; line: { x: number; y: number; w: number; h: number } }
  | { kind: 'join'; keep: Px; drop: Px }

interface Px { x: number; y: number; w: number; h: number }

/** A drag shorter than this (CSS px) does nothing. */
const DRAG_MIN = 6

interface TreeProps {
  ws: WorkspaceDef
  visible: boolean
  shared: Shared
  /** the area under the pointer (ctrl+space maximizes it) */
  hovered: { current: string | null }
}

/** The areas of a workspace and the borders between them (drag to resize). */
export function AreaTree({ ws, visible, shared, hovered }: TreeProps) {
  const { bench } = shared
  const host = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const drag = useRef<{ path: string; dir: SplitDir; start: number; len: number; lo: number; hi: number } | null>(null)
  const gesture = useRef<Gesture | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const previewRef = useRef<Preview | null>(null)
  const show = (p: Preview | null) => { previewRef.current = p; setPreview(p) }

  useEffect(() => {
    const el = host.current as HTMLDivElement
    const ro = new ResizeObserver(() => { if (el.clientWidth) setSize({ w: el.clientWidth, h: el.clientHeight }) })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const move = (e: PointerEvent) => {
      const d = drag.current
      if (!d) return
      const at = d.dir === 'row' ? e.clientX : e.clientY
      const ratio = Math.max(d.lo, Math.min(d.hi, (at - d.start) / d.len))
      bench.setRatio(ws.id, d.path, ratio, false)
    }
    const up = () => {
      if (!drag.current) return
      drag.current = null
      bench.save()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
  }, [bench, ws.id])

  const placed = useMemo(() => place(ws.root), [ws.root])
  // per area: the header's slot for the view's controls (a view renders into it)
  const [slots, setSlots] = useState<Record<string, HTMLElement | null>>({})
  const slotRefs = useRef(new Map<string, (el: HTMLElement | null) => void>())
  const slotRef = (id: string) => {
    let f = slotRefs.current.get(id)
    if (!f) {
      f = (el) => setSlots((s) => (s[id] === el ? s : { ...s, [id]: el }))
      slotRefs.current.set(id, f)
    }
    return f
  }

  // Corner drags: the preview follows the pointer; release applies it; Esc or a right
  // click cancels.
  useEffect(() => {
    const px = (r: Rect): Px => ({ x: r.x * size.w, y: r.y * size.h, w: r.w * size.w, h: r.h * size.h })
    const move = (e: PointerEvent) => {
      const g = gesture.current
      if (!g) return
      const box = (host.current as HTMLDivElement).getBoundingClientRect()
      const x = e.clientX - box.left
      const y = e.clientY - box.top
      const a = px(g.rect)
      const dx = e.clientX - g.x0
      const dy = e.clientY - g.y0
      if (Math.max(Math.abs(dx), Math.abs(dy)) < DRAG_MIN) { show(null); return }
      const inside = x >= a.x && x <= a.x + a.w && y >= a.y && y <= a.y + a.h
      if (inside) {
        // the dominant axis: a horizontal drag splits left and right
        const dir: SplitDir = Math.abs(dx) >= Math.abs(dy) ? 'row' : 'column'
        const pos = dir === 'row' ? x - a.x : y - a.y
        const len = dir === 'row' ? a.w : a.h
        const min = dir === 'row' ? MIN_AREA.w : MIN_AREA.h
        const line = dir === 'row' ? { x: x - 1, y: a.y, w: 2, h: a.h } : { x: a.x, y: y - 1, w: a.w, h: 2 }
        show({ kind: 'split', dir, ratio: pos / len, ok: pos >= min && len - pos >= min, line })
        return
      }
      // across an edge: a join if the neighbor there is the sibling area of the same split
      const over = { left: a.x - x, right: x - (a.x + a.w), above: a.y - y, below: y - (a.y + a.h) }
      const side = (Object.entries(over) as [keyof typeof over, number][]).sort((p, q) => q[1] - p[1])[0][0]
      const nb = neighborOf(ws.root, g.id)
      const target = nb && nb.side === side && nb.node.kind === 'area' ? placed.areas.find((p) => p.leaf.id === (nb.node as AreaLeaf).id) : null
      const d = target ? px(target.rect) : null
      if (target && d && x >= d.x && x <= d.x + d.w && y >= d.y && y <= d.y + d.h) show({ kind: 'join', keep: a, drop: d })
      else show(null)
    }
    const end = (apply: boolean) => {
      const g = gesture.current
      const p = previewRef.current
      gesture.current = null
      show(null)
      if (!g || !apply || !p) return
      if (p.kind === 'split' && p.ok) {
        const first = p.dir === 'row' ? !g.right : !g.bottom
        bench.split(g.id, p.dir, p.ratio, first)
      } else if (p.kind === 'join') bench.merge(g.id)
    }
    const up = (e: PointerEvent) => { if (gesture.current && e.button === 0) end(true) }
    const down = (e: PointerEvent) => { if (gesture.current && e.button !== 0) { e.preventDefault(); end(false) } }
    const key = (e: KeyboardEvent) => { if (gesture.current && e.key === 'Escape') { e.preventDefault(); end(false) } }
    const menu = (e: MouseEvent) => { if (gesture.current) { e.preventDefault(); end(false) } }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('keydown', key, true)
    window.addEventListener('contextmenu', menu, true)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointerdown', down, true)
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('contextmenu', menu, true)
    }
  }, [bench, ws.root, placed, size])
  const startGesture = (e: React.PointerEvent, id: string, rect: Rect, right: boolean, bottom: boolean) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    gesture.current = { id, rect, right, bottom, x0: e.clientX, y0: e.clientY }
  }
  const maximized = ws.maximized && placed.areas.some((a) => a.leaf.id === ws.maximized) ? ws.maximized : null
  const only = placed.areas.length === 1

  const startDrag = (e: React.PointerEvent, path: string, dir: SplitDir, r: Rect) => {
    e.preventDefault()
    const box = (host.current as HTMLDivElement).getBoundingClientRect()
    const split = nodeAt(ws.root, path)
    if (split.kind !== 'split') return
    const len = dir === 'row' ? r.w * box.width : r.h * box.height
    const ma = minSize(split.a)
    const mb = minSize(split.b)
    const lo = (dir === 'row' ? ma.w : ma.h) / len
    const hi = 1 - (dir === 'row' ? mb.w : mb.h) / len
    drag.current = { path, dir, len, start: dir === 'row' ? box.left + r.x * box.width : box.top + r.y * box.height,
      lo: lo <= hi ? lo : split.ratio, hi: lo <= hi ? hi : split.ratio }
  }

  return (
    <div className="area-tree" ref={host} style={{ display: visible ? 'block' : 'none' }}>
      {placed.areas.map(({ leaf, rect }) => {
        const shown = !maximized || maximized === leaf.id
        const r = maximized ? { x: 0, y: 0, w: 1, h: 1 } : rect
        const px = { w: r.w * size.w, h: r.h * size.h }
        return (
          <div key={leaf.id} className="area" data-area={leaf.id} data-view={leaf.view}
            style={{ ...rectStyle(r), display: shown ? 'flex' : 'none' }}
            onPointerDownCapture={() => bench.use(leaf.id)} onPointerEnter={() => { hovered.current = leaf.id }}>
            <AreaHeader ws={ws} leaf={leaf} bench={bench} only={only} maximized={maximized === leaf.id}
              canSplit={{ row: px.w >= 2 * MIN_AREA.w + GAP, column: px.h >= 2 * MIN_AREA.h + GAP }} slot={slotRef(leaf.id)} />
            <div className="area-body">
              <AreaContent key={`${leaf.id}:${leaf.view}`} id={leaf.id} view={leaf.view} shared={shared}
                slot={slots[leaf.id] ?? null} />
            </div>
            {!maximized && (['tl', 'tr', 'bl', 'br'] as const).map((c) => (
              <div key={c} className={`area-corner ${c}`} data-corner={c}
                onPointerDown={(e) => startGesture(e, leaf.id, rect, c[1] === 'r', c[0] === 'b')} />
            ))}
          </div>
        )
      })}
      {!maximized && placed.splits.map(({ path, dir, ratio, rect }) => {
        const style: CSSProperties = dir === 'row'
          ? { left: `calc(${(rect.x + rect.w * ratio) * 100}% - ${GAP / 2}px)`, width: GAP, top: `${rect.y * 100}%`, height: `${rect.h * 100}%` }
          : { top: `calc(${(rect.y + rect.h * ratio) * 100}% - ${GAP / 2}px)`, height: GAP, left: `${rect.x * 100}%`, width: `${rect.w * 100}%` }
        return <div key={`s${path}`} className={`area-border ${dir}`} data-split={path} style={style}
          onPointerDown={(e) => startDrag(e, path, dir, rect)} />
      })}
      {preview?.kind === 'split' && (
        <div className={preview.ok ? 'area-preview-line' : 'area-preview-line refused'}
          style={{ left: preview.line.x, top: preview.line.y, width: preview.line.w, height: preview.line.h }} />
      )}
      {preview?.kind === 'join' && <JoinPreview keep={preview.keep} drop={preview.drop} />}
    </div>
  )
}

/** The join preview: the area to be removed darkened, an arrow from the kept area into it. */
function JoinPreview({ keep, drop }: { keep: Px; drop: Px }) {
  const from = { x: keep.x + keep.w / 2, y: keep.y + keep.h / 2 }
  const to = { x: drop.x + drop.w / 2, y: drop.y + drop.h / 2 }
  const len = Math.hypot(to.x - from.x, to.y - from.y)
  const ux = (to.x - from.x) / len
  const uy = (to.y - from.y) / len
  const head = 14
  const tip = { x: to.x - ux * 8, y: to.y - uy * 8 }
  const left = { x: tip.x - ux * head - uy * head * 0.6, y: tip.y - uy * head + ux * head * 0.6 }
  const right = { x: tip.x - ux * head + uy * head * 0.6, y: tip.y - uy * head - ux * head * 0.6 }
  return (
    <>
      <div className="area-preview-drop" style={{ left: drop.x, top: drop.y, width: drop.w, height: drop.h }} />
      <svg className="area-preview-arrow" width="100%" height="100%">
        <line x1={from.x} y1={from.y} x2={tip.x - ux * head * 0.5} y2={tip.y - uy * head * 0.5} />
        <polygon points={`${tip.x},${tip.y} ${left.x},${left.y} ${right.x},${right.y}`} />
      </svg>
    </>
  )
}

interface HeaderProps {
  ws: WorkspaceDef
  leaf: AreaLeaf
  bench: Workbench
  only: boolean
  maximized: boolean
  canSplit: { row: boolean; column: boolean }
  slot: (el: HTMLElement | null) => void
}

function AreaHeader({ leaf, bench, only, maximized, canSplit, slot }: HeaderProps) {
  return (
    <div className="area-head">
      <select className="area-view" aria-label="view" value={leaf.view}
        onChange={(e) => bench.setView(leaf.id, e.target.value as ViewType)}>
        {VIEWS.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
      </select>
      <span className="spacer" />
      <span className="area-head-slot" ref={slot} />
      {!maximized && <>
        <IconButton icon="splitRow" tip="Split left and right" disabled={!canSplit.row} onClick={() => bench.split(leaf.id, 'row')} />
        <IconButton icon="splitColumn" tip="Split top and bottom" disabled={!canSplit.column} onClick={() => bench.split(leaf.id, 'column')} />
        <IconButton icon="close" tip="Close" disabled={only} onClick={() => bench.close(leaf.id)} />
      </>}
      {(!only || maximized) && <IconButton icon={maximized ? 'restore' : 'maximize'} tip={maximized ? 'Restore' : 'Maximize'}
        sub="ctrl+space" onClick={() => bench.toggleMaximized(leaf.id)} />}
    </div>
  )
}

interface ContentProps {
  id: string
  view: ViewType
  shared: Shared
  slot: HTMLElement | null
}

/** The view of an area, in the area's context (its sidebar state). Memoized: a layout
 * change that moves the area does not render the view again. */
const AreaContent = memo(function AreaContent({ id, view, shared, slot }: ContentProps) {
  const { trace, charges, pool, store, bench, source, onOpenSource } = shared
  const api = useMemo<AreaApi>(() => ({ id, slot, ui: (k) => bench.ui(id, k), setUi: (k, v) => bench.setUi(id, k, v) }), [bench, id, slot])
  const isKeyTarget = useCallback(() => bench.isKeyTarget(id), [bench, id])
  const onRenderer = useCallback((r: TimelineRenderer | null) => bench.setRenderer(id, r), [bench, id])
  let body
  if (view === 'timeline') {
    const t = bench.timeline(id)
    body = <Timeline trace={trace} charges={charges} pool={pool} store={store} blocks={t.blocks} reveal={t.reveal}
      isKeyTarget={isKeyTarget} onRenderer={onRenderer} />
  } else if (view === 'blocks') {
    body = <BlockView trace={trace} store={store} />
  } else if (view === 'instant') {
    body = <InstantView trace={trace} charges={charges} store={store} pool={pool} />
  } else {
    body = <SourceView maps={source.maps} error={source.error} onOpen={onOpenSource} trace={trace} store={store}
      request={bench.sourceRequests(id)} />
  }
  return <AreaContext.Provider value={api}>{body}</AreaContext.Provider>
})
