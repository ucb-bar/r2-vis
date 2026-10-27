// The workspaces of an open trace: the tabs at the top (a click shows one, a double click
// renames it, a drag moves it; add a copy, delete, reset all) and the areas of each one
// (ui/Areas.tsx). A workspace shown once stays mounted, so its areas keep their state.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ChargeCache } from '../data/charges'
import { prepareControl } from '../control/ControlView'
import type { WorkerPool } from '../data/pool'
import type { Trace } from '../data/trace'
import { leaves, loadLayout, type WorkspaceDef } from '../state/layout'
import { focusQueries } from '../state/focusqueries'
import type { ViewStore } from '../state/viewstore'
import { Workbench } from '../state/workbench'
import { FocusBar } from './FocusBar'
import type { OpenSourceMap } from '../App'
import { AreaTree, IconButton, InlineIcon, type Shared } from './Areas'

interface Props {
  trace: Trace
  charges: ChargeCache
  pool: WorkerPool
  store: ViewStore
  source: OpenSourceMap
  onOpenSource: (file: File) => void
}

export function Workspace({ trace, charges, pool, store, source, onOpenSource }: Props) {
  const [bench] = useState(() => new Workbench(trace, store, loadLayout()))
  const layout = useSyncExternalStore((cb) => bench.layout.subscribe(cb), () => bench.layout.get())
  useSyncExternalStore((cb) => bench.changes.subscribe(cb), () => bench.changes.get())
  const hovered = useRef<string | null>(null)
  const shared = useMemo<Shared>(() => ({ trace, charges, pool, store, bench, source, onOpenSource }),
    [trace, charges, pool, store, bench, source, onOpenSource])

  useEffect(() => {
    window.__r2workbench = bench
    // A task shown from another view goes to a Timeline area (state/workbench.ts).
    const offReveal = store.reveal.subscribe((task) => { if (task !== null) bench.reveal(task) })
    // A task's item shown in a Source area ("Show source" in the timeline); the task goes
    // into the focus (its item derived; origin 'source': the area routed here shows it).
    const offSource = store.showSource.subscribe((task) => {
      if (task === null) return
      bench.showSource(task)
      store.focus.set({ tasks: [task] }, { origin: 'source' })
    })
    // The focus queries, again (and the focus derived again) when the source maps or the
    // attribution scope change.
    const setQueries = () => store.focus.setQueries(focusQueries(trace, store.sourceMaps.get(), pool, () => store.scope.get()))
    setQueries()
    const offMaps = store.sourceMaps.subscribe(setQueries)
    const offScope = store.scope.subscribe(setQueries)
    // The focus items set from another view: a Source area follows them.
    let items = store.focus.get().items
    const offFocus = store.focus.subscribe((f) => { if (f.items !== items) { items = f.items; bench.followFocus(items) } })
    // ctrl+space maximizes the area under the pointer (else the last used one), or restores it.
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.code !== 'Space') return
      e.preventDefault()
      const ws = bench.active
      const ids = leaves(ws.root).map((l) => l.id)
      const id = ws.maximized && ids.includes(ws.maximized) ? ws.maximized
        : hovered.current && ids.includes(hovered.current) ? hovered.current : bench.lastUsedIn(ws)
      if (id) bench.toggleMaximized(id)
    }
    window.addEventListener('keydown', onKey)
    // The control data of the Instant views, built when the page is idle (the first
    // Instant area then mounts faster).
    const idle = requestIdleCallback(() => prepareControl(trace, pool), { timeout: 3000 })
    return () => { offReveal(); offSource(); offFocus(); offMaps(); offScope(); window.removeEventListener('keydown', onKey); cancelIdleCallback(idle) }
  }, [bench, store, trace, pool])

  return (
    <div className="workspace">
      <WorkspaceTabs bench={bench} workspaces={layout.workspaces} active={layout.active} focus={<FocusBar store={store} trace={trace} />} />
      <div className="workspace-body areas">
        {layout.workspaces.filter((w) => bench.mounted.has(w.id)).map((w) => (
          <AreaTree key={w.id} ws={w} visible={w.id === layout.active} shared={shared} hovered={hovered} />
        ))}
      </div>
    </div>
  )
}

function WorkspaceTabs({ bench, workspaces, active, focus }: { bench: Workbench; workspaces: WorkspaceDef[]; active: string; focus: React.ReactNode }) {
  const [editing, setEditing] = useState<string | null>(null)
  const dragged = useRef<string | null>(null)
  const [drop, setDrop] = useState<{ id: string; after: boolean } | null>(null)

  const onDrop = (target: string, after: boolean) => {
    const id = dragged.current
    dragged.current = null
    setDrop(null)
    if (!id || id === target) return
    const rest = workspaces.filter((w) => w.id !== id)
    const at = rest.findIndex((w) => w.id === target)
    bench.move(id, at + (after ? 1 : 0))
  }

  return (
    <nav className="tabs ws-tabs">
      {workspaces.map((w) => {
        if (editing === w.id) {
          return (
            <input key={w.id} className="tab-input" aria-label="workspace name" autoFocus defaultValue={w.name}
              onFocus={(e) => e.target.select()}
              onBlur={(e) => { bench.rename(w.id, e.target.value); setEditing(null) }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                else if (e.key === 'Escape') setEditing(null)
              }} />
          )
        }
        const cls = ['tab', w.id === active ? 'active' : '',
          drop?.id === w.id ? (drop.after ? 'drop-after' : 'drop-before') : ''].join(' ').trim()
        return (
          <button key={w.id} className={cls} data-ws={w.id} draggable
            onClick={() => bench.activate(w.id)} onDoubleClick={() => setEditing(w.id)}
            onDragStart={(e) => { dragged.current = w.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', w.name) }}
            onDragEnd={() => { dragged.current = null; setDrop(null) }}
            onDragOver={(e) => {
              if (!dragged.current) return
              e.preventDefault()
              const r = e.currentTarget.getBoundingClientRect()
              const after = e.clientX > r.left + r.width / 2
              if (drop?.id !== w.id || drop.after !== after) setDrop({ id: w.id, after })
            }}
            onDrop={(e) => { e.preventDefault(); onDrop(w.id, drop?.id === w.id ? drop.after : false) }}>
            {w.name}
            {w.id === active && workspaces.length > 1 && (
              <InlineIcon icon="close" tip="Delete workspace" onClick={() => bench.remove(w.id)} />
            )}
          </button>
        )
      })}
      <IconButton icon="add" tip="Add a copy of this workspace" onClick={() => bench.addCopy()} />
      {focus}
      <span className="spacer" />
      <IconButton icon="reset" tip="Reset all workspaces" onClick={() => {
        if (window.confirm('Reset all workspaces to the defaults?')) bench.resetAll()
      }} />
    </nav>
  )
}
