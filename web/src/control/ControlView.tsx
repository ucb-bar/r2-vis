import { useEffect, useMemo, useState } from 'react'
import { isDict } from '../data/columns'
import { taskLabel } from '../data/labels'
import type { Trace } from '../data/trace'
import type { ViewStore } from '../state/viewstore'
import { recorded } from '../timeline/rows'
import { ControlIndex } from './index'

interface Props {
  trace: Trace
  store: ViewStore
}

/** Rows shown per table before "show all". */
const ROW_LIMIT = 100

const OTHER_TABLES = [
  ['pending', 'cap_pending'], ['versions', 'cap_versions'], ['inbound refs', 'cap_inbound_refs'],
  ['inbound invokes', 'cap_inbound_invokes'], ['outbound deps', 'cap_outbound_deps'],
  ['outbound invokes', 'cap_outbound_invokes'],
] as const

declare global {
  interface Window { __r2control?: ControlIndex }
}

/** The control instant view: per Neutrino of the block selection, its scoreboard and its
 * execution table at the cursor time (the pinned time, or the last cursor position). A
 * click on a task or a producer shows it in the timeline. */
export function ControlView({ trace, store }: Props) {
  const rec = useMemo(() => recorded(trace), [trace])
  const index = useMemo(() => {
    const t0 = performance.now()
    const ix = new ControlIndex(trace)
    ix.buildMs = performance.now() - t0
    return ix
  }, [trace])
  const [t, setT] = useState<{ t: number; pinned: boolean } | null>(store.cursor.get())
  const [checked, setChecked] = useState(store.blocks.get())
  const [kind, setKind] = useState<number>(-1)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())

  useEffect(() => {
    window.__r2control = index
    let frame = 0
    let next = store.cursor.get()
    const offCursor = store.cursor.subscribe((c) => {
      if (!c) return  // keep the last time: the pointer leaves the timeline to get here
      next = c
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; setT(next) })
    })
    const offBlocks = store.blocks.subscribe(setChecked)
    return () => { offCursor(); offBlocks(); if (frame) cancelAnimationFrame(frame) }
  }, [store, index])

  const c = trace.facts.tasks.cols
  const gid = c.gid as Int32Array
  const kindCol = c.kind && isDict(c.kind) ? c.kind : null
  const kinds = kindCol?.dict ?? []
  const nodes = trace.dims.nodes.filter((n) => checked.has(n.id as number))
  const fmt = (v: number) => Math.round(v).toLocaleString('en-US')
  const label = (task: number) => taskLabel(trace, task) ?? `task ${gid[task]}`
  const keep = (task: number) => kind < 0 || (kindCol !== null && kindCol.codes[task] === kind)
  const reveal = (task: number) => store.reveal.set(task)
  const toggle = (key: string) => {
    const next = new Set(expanded)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setExpanded(next)
  }
  const limit = <T,>(key: string, rows: T[]) => (expanded.has(key) ? rows : rows.slice(0, ROW_LIMIT))
  const more = (key: string, n: number) => n > ROW_LIMIT && (
    <button className="button small" onClick={() => toggle(key)}>
      {expanded.has(key) ? 'show fewer' : `show all ${n}`}
    </button>
  )
  const cap = (node: Record<string, unknown>, col: string) => {
    const v = node[col]
    return typeof v === 'number' ? v : null
  }
  const ofCap = (n: number, capacity: number | null) => (capacity === null ? `${n}` : `${n} of ${capacity}`)

  return (
    <div className="control">
      <div className="control-head">
        <span className="instant-active">
          {t ? `t = ${fmt(t.t)} cycles${t.pinned ? ' (pinned)' : ' (last cursor position; Alt+click in the timeline pins a time)'}`
            : 'Move the pointer over the timeline, or pin a time with Alt+click.'}
        </span>
        <span className="spacer" />
        {kinds.length > 0 && (
          <label className="tool">
            kind
            <select value={kind} onChange={(e) => setKind(Number(e.target.value))}>
              <option value={-1}>all</option>
              {kinds.map((k, i) => <option key={k} value={i}>{k}</option>)}
            </select>
          </label>
        )}
      </div>
      <div className="control-body">
        {nodes.length === 0 && <div className="instant-note">No blocks are in the timeline. Add blocks in the Blocks panel or the block diagram.</div>}
        {t && nodes.map((n) => {
          const id = n.id as number
          const tables = index.at(id, t.t)
          const sb = tables.scoreboard.filter(keep)
          const ex = tables.execution.filter(keep)
          const executing = ex.filter((i) => !((c.complete as Float64Array)[i] <= t.t))
          const sbKey = `s${id}`
          const exKey = `e${id}`
          const capSb = cap(n, 'cap_scoreboard')
          const capEx = cap(n, 'cap_execution')
          const w = rec.window
          const missing = !rec.tasks ? 'tasks are not recorded in this dump'
            : !rec.inTree[id] ? 'not recorded in this dump (outside the recorded blocks)'
              : w && (t.t < w[0] || t.t >= w[1]) ? `t is outside the recorded window [${fmt(w[0])}, ${fmt(w[1])})` : null
          if (missing) {
            return (
              <div key={id} className="control-empty">
                <strong>{String(n.path)}</strong><span className="muted"> · {missing}</span>
              </div>
            )
          }
          if (sb.length === 0 && ex.length === 0) {
            return (
              <div key={id} className="control-empty">
                <strong>{String(n.path)}</strong>
                <span className="muted"> · scoreboard {ofCap(0, capSb)} · execution table {ofCap(0, capEx)}</span>
              </div>
            )
          }
          return (
            <section key={id} className="control-node">
              <h3>{String(n.path)}</h3>
              <div className="control-table">
                <div className="control-title">
                  Scoreboard <span className="count">{ofCap(sb.length, capSb)}</span>
                  {kind >= 0 && <span className="muted"> ({tables.scoreboard.length} of all kinds)</span>}
                </div>
                {sb.length > 0 && (
                  <table>
                    <thead><tr><th>label</th><th>gid</th><th>version</th><th>waiting</th><th>deps left</th><th>producers (* remote)</th></tr></thead>
                    <tbody>
                      {limit(sbKey, sb).map((task) => {
                        const deps = index.pendingDeps(task, t.t)
                        const version = (c.version as Int32Array)[task]
                        return (
                          <tr key={task}>
                            <td><button className="link" onClick={() => reveal(task)}>{label(task)}</button></td>
                            <td className="num">{gid[task]}</td>
                            <td className="num">{version >= 0 ? version : ''}</td>
                            <td className="num">{fmt(t.t - (c.invoke as Float64Array)[task])}</td>
                            <td className="num">{deps.length}</td>
                            <td className="producers">
                              {deps.slice(0, 8).map((d, k) => {
                                if (d.producer < 0) return <span key={k} className="muted">store </span>
                                const row = index.rowOf(d.producer)
                                return row < 0
                                  ? <span key={k} className="muted" title="not in the trace">{d.producer} </span>
                                  : <button key={k} className="link" title={`${label(row)}${d.remote ? ' (remote)' : ''}`}
                                    onClick={() => reveal(row)}>{d.producer}{d.remote ? '*' : ''}</button>
                              })}
                              {deps.length > 8 && <span className="muted">+{deps.length - 8}</span>}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                )}
                {more(sbKey, sb.length)}
              </div>
              <div className="control-table">
                <div className="control-title">
                  Execution table <span className="count">{ofCap(ex.length, capEx)}</span>
                  <span className="muted"> · {executing.length} executing, {ex.length - executing.length} done</span>
                </div>
                {ex.length > 0 && (
                  <table>
                    <thead><tr><th>label</th><th>gid</th><th>version</th><th>state</th><th>since issue</th></tr></thead>
                    <tbody>
                      {limit(exKey, ex).map((task) => {
                        const version = (c.version as Int32Array)[task]
                        const done = (c.complete as Float64Array)[task] <= t.t
                        return (
                          <tr key={task}>
                            <td><button className="link" onClick={() => reveal(task)}>{label(task)}</button></td>
                            <td className="num">{gid[task]}</td>
                            <td className="num">{version >= 0 ? version : ''}</td>
                            <td>{done ? 'done' : 'executing'}</td>
                            <td className="num">{fmt(t.t - (c.issue as Float64Array)[task])}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                )}
                {more(exKey, ex.length)}
              </div>
              <div className="control-other muted">
                Not recorded in trace v1.0: {OTHER_TABLES.map(([name, col]) => {
                  const v = cap(n, col)
                  return v === null ? name : `${name} (${v})`
                }).join(', ')}
              </div>
            </section>
          )
        })}
      </div>
    </div>
  )
}
