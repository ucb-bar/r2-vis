import { useEffect, useState } from 'react'
import type { ChargeCache } from '../data/charges'
import type { WorkerPool } from '../data/pool'
import type { Trace } from '../data/trace'
import type { ViewStore } from '../state/viewstore'
import { ControlView } from '../control/ControlView'
import type { TimelineRenderer } from '../timeline/renderer'
import { TrafficView } from '../traffic/TrafficView'
import { TimeStrip } from './TimeStrip'

type Mode = 'traffic' | 'control'

interface Props {
  trace: Trace
  charges: ChargeCache
  store: ViewStore
  /** the timeline's renderer when the scrubber is shown (not in the docked split) */
  strip: TimelineRenderer | null
  pool: WorkerPool
}

/** The instant views: traffic at the active time range of the shared state
 * (views-design Section 3) and control at the cursor time (Section 4). */
export function InstantView({ trace, charges, store, strip, pool }: Props) {
  const [, setTick] = useState(0)
  const [follow, setFollow] = useState(store.followCursor.get())
  const [mode, setMode] = useState<Mode>('traffic')
  useEffect(() => {
    let frame = 0
    const bump = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; setTick((t) => t + 1) }) }
    const offs = [store.window.subscribe(bump), store.range.subscribe(bump), store.cursor.subscribe(bump),
      store.followCursor.subscribe((f) => { setFollow(f); bump() }), store.smoothing.subscribe(bump)]
    return () => { offs.forEach((off) => off()); if (frame) cancelAnimationFrame(frame) }
  }, [store])
  const active = store.activeRange()
  const cursor = store.cursor.get()
  const n = (t: number) => Math.round(t).toLocaleString('en-US')
  const what = active.kind === 'cursor'
    ? `cursor at ${n(cursor?.t ?? active.a)} cycles${cursor?.pinned ? ' (pinned)' : ''}, averaged over [${n(active.a)}, ${n(active.b)}) (smoothing ${store.smoothing.get()} px)`
    : `${active.kind === 'range' ? 'range' : 'time window'} [${n(active.a)}, ${n(active.b)}) · ${n(active.b - active.a)} cycles`
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
        {mode === 'traffic' && (
          <label className="tool">
            <input type="checkbox" checked={follow} onChange={(e) => store.followCursor.set(e.target.checked)} />
            follow cursor
          </label>
        )}
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
