import { useEffect, useRef, useState } from 'react'
import { fromDrop, fromFileList, type TraceFiles } from './data/files'
import { WorkerPool, defaultPoolSize } from './data/pool'
import { loadTrace, type Trace } from './data/trace'
import { indexLabels } from './data/labels'
import { ChargeCache } from './data/charges'
import { ViewStore } from './state/viewstore'
import { homeRange } from './timeline/rows'
import { OpenPanel } from './ui/OpenPanel'
import { LoadReport } from './ui/LoadReport'
import { Workspace } from './ui/Workspace'
import { ThemeToggle } from './ui/ThemeToggle'

type State =
  | { kind: 'idle' }
  | { kind: 'loading'; name: string; done: number; total: number }
  | { kind: 'loaded'; trace: Trace; charges: ChargeCache; store: ViewStore }
  | { kind: 'error'; message: string }

declare global {
  interface Window { __r2vis?: { trace?: Trace; charges?: ChargeCache; store?: ViewStore; open?: (tf: TraceFiles) => Promise<void> } }
}

export function App() {
  const [state, setState] = useState<State>({ kind: 'idle' })
  const poolRef = useRef<WorkerPool | null>(null)
  const [showLoad, setShowLoad] = useState(false)

  const pool = () => (poolRef.current ??= new WorkerPool(defaultPoolSize()))

  const open = async (tf: TraceFiles) => {
    setState({ kind: 'loading', name: tf.name, done: 0, total: 1 })
    try {
      pool().reset()
      const trace = await loadTrace(tf, pool(), (done, total) =>
        setState({ kind: 'loading', name: tf.name, done, total }))
      void indexLabels(trace, pool())   // which task labels are shared (task names), in a worker
      const charges = new ChargeCache(trace)
      const store = new ViewStore(trace.dims.nodes.map((n) => n.id as number), trace.manifest.end_time, homeRange(trace))
      window.__r2vis = { ...window.__r2vis, trace, charges, store }
      setState({ kind: 'loaded', trace, charges, store })
    } catch (err) {
      setState({ kind: 'error', message: String((err as Error).message ?? err) })
    }
  }

  useEffect(() => {
    window.__r2vis = { ...window.__r2vis, open }
    return () => poolRef.current?.terminate()
  }, [])

  const onFiles = (list: FileList) => {
    try { void open(fromFileList(list)) } catch (err) { setState({ kind: 'error', message: String((err as Error).message) }) }
  }
  const onDrop = async (dt: DataTransfer) => {
    try { await open(await fromDrop(dt)) } catch (err) { setState({ kind: 'error', message: String((err as Error).message) }) }
  }

  return (
    <div className="app">
      <header className="header">
        <h1>r2-vis</h1>
        {state.kind === 'loaded' && (
          <span className="meta">
            {state.trace.name} · {state.trace.manifest.end_time.toLocaleString()} cycles ·{' '}
            {state.trace.facts.tasks.rows.toLocaleString()} tasks
          </span>
        )}
        <span className="spacer" />
        {state.kind === 'loaded' && (
          <button className={showLoad ? 'button active' : 'button'} onClick={() => setShowLoad(!showLoad)}>
            Loaded in {Math.round(state.trace.load.totalMs)} ms
          </button>
        )}
        {state.kind === 'loaded' && <OpenPanel compact onFiles={onFiles} onDrop={onDrop} />}
        <ThemeToggle />
      </header>
      <main className="main">
        {state.kind !== 'loaded' && (
          <OpenPanel onFiles={onFiles} onDrop={onDrop}>
            {state.kind === 'loading' && (
              <>
                <div>Loading {state.name}…</div>
                <div className="progress"><div style={{ width: `${(100 * state.done) / state.total}%` }} /></div>
              </>
            )}
            {state.kind === 'error' && <div className="error">{state.message}</div>}
          </OpenPanel>
        )}
        {state.kind === 'loaded' && (
          <Workspace key={state.trace.name + state.trace.load.totalMs} trace={state.trace}
            charges={state.charges} pool={pool()} store={state.store} />
        )}
        {state.kind === 'loaded' && showLoad && (
          <div className="overlay" onClick={() => setShowLoad(false)}>
            <div onClick={(e) => e.stopPropagation()}><LoadReport trace={state.trace} /></div>
          </div>
        )}
      </main>
    </div>
  )
}
