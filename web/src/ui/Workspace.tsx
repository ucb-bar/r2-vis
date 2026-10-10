import { useEffect, useRef, useState } from 'react'
import { BlockView } from '../blocks/BlockView'
import type { ChargeCache } from '../data/charges'
import type { WorkerPool } from '../data/pool'
import type { Trace } from '../data/trace'
import type { ViewStore } from '../state/viewstore'
import type { TimelineRenderer } from '../timeline/renderer'
import { Timeline } from '../timeline/Timeline'
import { InstantView } from './InstantView'

type Tab = 'timeline' | 'blocks' | 'instant'

interface Props {
  trace: Trace
  charges: ChargeCache
  pool: WorkerPool
  store: ViewStore
}

// The design starts at the top-level device: the block diagram is the way into the
// timeline (views-design 6.5).
const TABS: { id: Tab; label: string }[] = [
  { id: 'blocks', label: 'Block diagram' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'instant', label: 'Instant' },
]

/** Tabs Block diagram / Timeline / Instant (the block diagram first). Every view stays mounted (hidden when not
 * shown), so it keeps its state. The instant view can be docked under the timeline. */
export function Workspace({ trace, charges, pool, store }: Props) {
  const [tab, setTab] = useState<Tab>('blocks')
  const [docked, setDocked] = useState(false)
  const [timeline, setTimeline] = useState<TimelineRenderer | null>(null)
  const [split, setSplit] = useState(0.7)
  const body = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)

  // A task shown from another view: switch to the timeline (a docked instant view stays).
  useEffect(() => store.reveal.subscribe((task) => { if (task !== null) setTab('timeline') }), [store])

  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (!dragging.current || !body.current) return
      const r = body.current.getBoundingClientRect()
      setSplit(Math.max(0.2, Math.min(0.9, (e.clientY - r.top) / r.height)))
    }
    const up = () => { dragging.current = false }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
  }, [])

  const showDock = docked && tab === 'timeline'
  const instantHere = tab === 'instant' || showDock
  return (
    <div className="workspace">
      <nav className="tabs">
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? 'tab active' : 'tab'} onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </nav>
      <div className="workspace-body" ref={body}>
        <div className="pane" style={{ display: tab === 'timeline' ? 'flex' : 'none', flex: showDock ? `0 0 ${split * 100}%` : '1 1 auto' }}>
          <Timeline trace={trace} charges={charges} pool={pool} store={store} docked={docked} onDock={setDocked}
            onRenderer={setTimeline} />
        </div>
        {showDock && <div className="splitter" onPointerDown={(e) => { e.preventDefault(); dragging.current = true }} />}
        <div className="pane" style={{ display: tab === 'blocks' ? 'flex' : 'none', flex: '1 1 auto' }}>
          <BlockView trace={trace} store={store} />
        </div>
        <div className="pane" style={{ display: instantHere ? 'flex' : 'none', flex: '1 1 auto' }}>
          <InstantView trace={trace} charges={charges} store={store}
            strip={tab === 'instant' && timeline ? timeline : null} pool={pool} />
        </div>
      </div>
    </div>
  )
}
