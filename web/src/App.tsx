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
import { parseSourceMap } from './source/srcmap'
import type { LoadedMap } from './source/links'
import { fetchIndex, parseServerUrl, resetWhole, servedFiles, traceUrl, type ServedTrace } from './data/tracefile'
import { bytes } from './ui/format'
import { SourceView } from './source/SourceView'

/** The source maps in memory (the Source view), in the order opened; the error of the last
 * open. A run can use the images of several crates, one map each. */
export interface OpenSourceMap { maps: LoadedMap[]; error: string | null }

type State =
  | { kind: 'idle' }
  | { kind: 'loading'; name: string; done: number; total: number }
  | { kind: 'loaded'; trace: Trace; charges: ChargeCache; store: ViewStore }
  | { kind: 'error'; message: string }

declare global {
  interface Window { __r2vis?: { trace?: Trace; charges?: ChargeCache; store?: ViewStore; open?: (tf: TraceFiles) => Promise<void>; openSourceMap?: (f: File) => Promise<void>; openUrl?: (u: string) => Promise<void> } }
}

export function App() {
  const [state, setState] = useState<State>({ kind: 'idle' })
  const poolRef = useRef<WorkerPool | null>(null)
  const [showLoad, setShowLoad] = useState(false)
  const [src, setSrc] = useState<OpenSourceMap>({ maps: [], error: null })
  // The traces of an r2t-serve base URL, listed on the start page.
  const [served, setServed] = useState<{ base: string; traces: ServedTrace[] } | null>(null)
  /** Adds a source map; a map with the same file name replaces the old one. */
  const openSourceMap = async (file: File) => {
    try {
      const map = parseSourceMap(await file.text(), file.name)
      setSrc((s) => {
        const at = s.maps.findIndex((m) => m.name === file.name)
        const maps = at < 0 ? [...s.maps, { name: file.name, map }] : s.maps.map((m, k) => (k === at ? { name: file.name, map } : m))
        return { maps, error: null }
      })
    } catch (err) {
      setSrc((s) => ({ ...s, error: String((err as Error).message ?? err) }))
    }
  }

  const pool = () => (poolRef.current ??= new WorkerPool(defaultPoolSize()))

  /** Keeps #trace= on the open served trace (a reload reopens it); a local trace clears it. */
  const setFragment = (url: string | null) => {
    const hash = url ? `#trace=${encodeURIComponent(url)}` : ''
    if (location.hash !== hash) history.replaceState(null, '', `${location.pathname}${location.search}${hash}`)
  }

  const open = async (tf: TraceFiles) => {
    setState({ kind: 'loading', name: tf.name, done: 0, total: 1 })
    setFragment(tf.url ?? null)
    try {
      pool().reset()
      resetWhole()
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

  /** A server base URL lists its traces; a trace URL opens that trace. */
  const openUrl = async (input: string) => {
    try {
      const { base, trace } = parseServerUrl(input)
      const traces = await fetchIndex(base)
      if (trace === null) {
        setServed({ base, traces })
        setFragment(base)
        setState({ kind: 'idle' })
        return
      }
      const t = traces.find((x) => x.name === trace)
      if (!t) throw new Error(`${base}: no trace named ${trace} (the server lists ${traces.map((x) => x.name).join(', ') || 'none'})`)
      setServed({ base, traces })
      await open({ name: t.name, files: servedFiles(base, t), url: traceUrl(base, t.name) })
    } catch (err) {
      setState({ kind: 'error', message: String((err as Error).message ?? err) })
    }
  }

  // The views of an open trace read the maps from its store (task tooltips, Show source).
  useEffect(() => { if (state.kind === 'loaded') state.store.sourceMaps.set(src.maps) }, [state, src.maps])

  useEffect(() => {
    window.__r2vis = { ...window.__r2vis, open, openSourceMap, openUrl }
    const fromHash = new URLSearchParams(location.hash.slice(1)).get('trace')
    if (fromHash) void openUrl(fromHash)
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
        {(state.kind === 'loaded' || src.maps.length > 0) && <OpenPanel compact onFiles={onFiles} onDrop={onDrop} />}
        <ThemeToggle />
      </header>
      <main className="main">
        {state.kind !== 'loaded' && src.maps.length > 0 && (
          <div className="workspace">
            <nav className="tabs"><button className="tab active">Source</button></nav>
            <div className="workspace-body">
              <div className="pane" style={{ display: 'flex', flex: '1 1 auto' }}>
                <SourceView maps={src.maps} error={src.error} onOpen={(f) => void openSourceMap(f)} />
              </div>
            </div>
          </div>
        )}
        {state.kind !== 'loaded' && !src.maps.length && (
          <OpenPanel onFiles={onFiles} onDrop={onDrop} onSourceMap={(f) => void openSourceMap(f)} onUrl={(u) => void openUrl(u)}>
            {served && state.kind !== 'loading' && (
              <table className="served">
                <tbody>{served.traces.map((t) => (
                  <tr key={t.name}>
                    <td><button className="link" onClick={() => void openUrl(traceUrl(served.base, t.name))}>{t.name}</button></td>
                    <td className="num">{bytes(Object.values(t.files).reduce((a, b) => a + b, 0))}</td>
                  </tr>
                ))}</tbody>
              </table>
            )}
            {state.kind === 'loading' && (
              <>
                <div>Loading {state.name}…</div>
                <div className="progress"><div style={{ width: `${(100 * state.done) / state.total}%` }} /></div>
              </>
            )}
            {state.kind === 'error' && <div className="error">{state.message}</div>}
            {src.error && <div className="error">{src.error}</div>}
          </OpenPanel>
        )}
        {state.kind === 'loaded' && (
          <Workspace key={state.trace.name + state.trace.load.totalMs} trace={state.trace}
            charges={state.charges} pool={pool()} store={state.store} source={src} onOpenSource={(f) => void openSourceMap(f)} />
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
