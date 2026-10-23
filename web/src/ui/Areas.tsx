// The areas of one workspace (state/layout.ts): placed side by side as absolute boxes, all
// children of one element, so that a split, a merge or a close does not remount the views
// that stay. Each area has a thin header: its view, split, merge, close, maximize.
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

const MERGE_ICON: Record<string, IconName> = { left: 'mergeLeft', right: 'mergeRight', above: 'mergeUp', below: 'mergeDown' }

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
  const maximized = ws.maximized && placed.areas.some((a) => a.leaf.id === ws.maximized) ? ws.maximized : null
  const only = placed.areas.length === 1
  const hasTimeline = placed.areas.some((a) => a.leaf.view === 'timeline')
  const strip = hasTimeline ? null : bench.stripRenderer()

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
              canSplit={{ row: px.w >= 2 * MIN_AREA.w + GAP, column: px.h >= 2 * MIN_AREA.h + GAP }} />
            <div className="area-body">
              <AreaContent key={`${leaf.id}:${leaf.view}`} id={leaf.id} view={leaf.view} shared={shared}
                strip={leaf.view === 'instant' ? strip : null} />
            </div>
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
    </div>
  )
}

interface HeaderProps {
  ws: WorkspaceDef
  leaf: AreaLeaf
  bench: Workbench
  only: boolean
  maximized: boolean
  canSplit: { row: boolean; column: boolean }
}

function AreaHeader({ ws, leaf, bench, only, maximized, canSplit }: HeaderProps) {
  const nb = neighborOf(ws.root, leaf.id)
  return (
    <div className="area-head">
      <select className="area-view" aria-label="view" value={leaf.view}
        onChange={(e) => bench.setView(leaf.id, e.target.value as ViewType)}>
        {VIEWS.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
      </select>
      <span className="spacer" />
      {!maximized && <>
        <IconButton icon="splitRow" tip="Split left and right" disabled={!canSplit.row} onClick={() => bench.split(leaf.id, 'row')} />
        <IconButton icon="splitColumn" tip="Split top and bottom" disabled={!canSplit.column} onClick={() => bench.split(leaf.id, 'column')} />
        {nb && <IconButton icon={MERGE_ICON[nb.side]} tip={`Merge with the area ${nb.side === 'left' || nb.side === 'right' ? `on the ${nb.side}` : nb.side}`}
          disabled={nb.node.kind !== 'area'} onClick={() => bench.merge(leaf.id)} />}
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
  strip: TimelineRenderer | null
}

/** The view of an area, in the area's context (its sidebar state). Memoized: a layout
 * change that moves the area does not render the view again. */
const AreaContent = memo(function AreaContent({ id, view, shared, strip }: ContentProps) {
  const { trace, charges, pool, store, bench, source, onOpenSource } = shared
  const api = useMemo<AreaApi>(() => ({ id, ui: (k) => bench.ui(id, k), setUi: (k, v) => bench.setUi(id, k, v) }), [bench, id])
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
    body = <InstantView trace={trace} charges={charges} store={store} strip={strip} pool={pool} />
  } else {
    body = <SourceView map={source.map} name={source.name} error={source.error} onOpen={onOpenSource} />
  }
  return <AreaContext.Provider value={api}>{body}</AreaContext.Provider>
})
