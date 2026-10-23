import { useEffect, useState } from 'react'
import type { ChargeCache } from '../data/charges'
import type { WorkerPool } from '../data/pool'
import type { Trace } from '../data/trace'
import type { ViewStore } from '../state/viewstore'
import { ControlView } from '../control/ControlView'
import type { TimelineRenderer } from '../timeline/renderer'
import { TrafficView } from '../traffic/TrafficView'
import { TimeStrip } from './TimeStrip'
import { cycles, span } from './format'

type Mode = 'traffic' | 'control'

interface Props {
  trace: Trace
  charges: ChargeCache
  store: ViewStore
  /** a timeline's renderer when the scrubber is shown (the area's workspace has no Timeline area) */
  strip: TimelineRenderer | null
  pool: WorkerPool
}

/** The instant views: traffic and control at the cursor of the shared state, else over
 * its range, else over the window (views-design Sections 3, 4 and 7). */
export function InstantView({ trace, charges, store, strip, pool }: Props) {
  const [, setTick] = useState(0)
  const [mode, setMode] = useState<Mode>('traffic')
  useEffect(() => {
    let frame = 0
    const bump = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; setTick((t) => t + 1) }) }
    const offs = [store.window.subscribe(bump), store.range.subscribe(bump), store.cursor.subscribe(bump),
      store.smoothing.subscribe(bump)]
    return () => { offs.forEach((off) => off()); if (frame) cancelAnimationFrame(frame) }
  }, [store])
  const active = store.activeRange()
  const cursor = store.cursor.get()
  const what = active.kind === 'cursor' ? `t = ${cycles(cursor?.t ?? active.a)}` : span(active.a, active.b)
  return (
    <div className="instant">
      {strip && <TimeStrip store={store} timeline={strip} />}
      <div className="instant-head">
        <div className="segmented" role="tablist">
          {(['traffic', 'control'] as Mode[]).map((m) => (
            <button key={m} role="tab" aria-selected={mode === m} className={mode === m ? 'seg active' : 'seg'}
              onClick={() => setMode(m)}>{m === 'traffic' ? 'Traffic' : 'Control'}</button>
          ))}
        </div>
        {mode === 'traffic' && <span className="instant-active">{what}</span>}
        <span className="spacer" />
      </div>
      <div className="instant-main" style={{ display: mode === 'traffic' ? 'flex' : 'none' }}>
        <TrafficView trace={trace} charges={charges} store={store} />
      </div>
      <div className="instant-main" style={{ display: mode === 'control' ? 'flex' : 'none' }}>
        <ControlView trace={trace} store={store} pool={pool} />
      </div>
    </div>
  )
}
