import { useState, type ReactNode } from 'react'
import { isDict } from '../data/columns'
import { taskLabel, taskName } from '../data/labels'
import type { Trace } from '../data/trace'
import type { ViewStore } from '../state/viewstore'
import { count, cycles, num, pct, span } from '../ui/format'
import type { ControlIndex } from './index'
import { TABLES, type ControlData } from './pressure'

/** Rows shown per list before "show all". */
const ROW_LIMIT = 100

interface Props {
  trace: Trace
  store: ViewStore
  data: ControlData
  index: ControlIndex
  node: number
  t: number
  range: { a: number; b: number }
}

/** The sidebar of the control view for one Neutrino (views-design 6.3): per table its
 * pressure (n of N at the time; average and peak over the range) and a fold that lists
 * its items. A click on a task shows it in the timeline. */
export function NodePanel({ trace, store, data, index, node, t, range }: Props) {
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set([0]))
  const [all, setAll] = useState<ReadonlySet<number>>(new Set())
  const [kind, setKind] = useState(-1)
  const c = trace.facts.tasks.cols
  const gid = c.gid as Int32Array
  const kindCol = c.kind && isDict(c.kind) ? c.kind : null
  const label = (task: number) => taskLabel(trace, task) ?? `task ${gid[task]}`
  const reveal = (task: number) => store.reveal.set(task)
  const keep = (task: number) => kind < 0 || (kindCol !== null && kindCol.codes[task] === kind)
  const toggle = (set: ReadonlySet<number>, id: number) => {
    const next = new Set(set)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  }
  const limit = <T,>(id: number, rows: T[]) => (all.has(id) ? rows : rows.slice(0, ROW_LIMIT))
  const more = (id: number, n: number) => n > ROW_LIMIT && (
    <button className="button small" onClick={() => setAll(toggle(all, id))}>{all.has(id) ? 'show fewer' : `show all ${n}`}</button>
  )
  const share = (v: number, cap: number | null) => (cap ? ` · ${pct(v / cap)}` : '')
  const tasks = index.at(node, t)
  const nodes = trace.dims.nodes

  const taskCell = (row: number) => (row < 0 ? <span className="muted">none</span>
    : <button className="link" onClick={() => reveal(row)}>{label(row)}</button>)

  const lists: Record<number, () => ReactNode> = {
    0: () => {
      const sb = tasks.scoreboard.filter(keep)
      return (
        <>
          <table>
            <thead><tr><th>label</th><th>gid</th><th>version</th><th>waiting</th><th>deps left</th><th>producers (* remote)</th></tr></thead>
            <tbody>
              {limit(0, sb).map((task) => {
                const deps = index.pendingDeps(task, t)
                const version = (c.version as Int32Array)[task]
                return (
                  <tr key={task}>
                    <td>{taskCell(task)}</td>
                    <td className="num">{gid[task]}</td>
                    <td className="num">{version >= 0 ? version : ''}</td>
                    <td className="num">{count(t - (c.invoke as Float64Array)[task])}</td>
                    <td className="num">{deps.length}</td>
                    <td className="producers">
                      {deps.slice(0, 8).map((d, k) => {
                        if (d.producer < 0) return <span key={k} className="muted">store </span>
                        const row = index.rowOf(d.producer)
                        return row < 0
                          ? <span key={k} className="muted" title="not in the trace">{d.producer} </span>
                          : <button key={k} className="link" title={`${taskName(trace, row)}${d.remote ? ' · remote' : ''}`}
                            onClick={() => reveal(row)}>{d.producer}{d.remote ? '*' : ''}</button>
                      })}
                      {deps.length > 8 && <span className="muted">+{deps.length - 8}</span>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {more(0, sb.length)}
        </>
      )
    },
    1: () => {
      const ex = tasks.execution.filter(keep)
      return (
        <>
          <table>
            <thead><tr><th>label</th><th>gid</th><th>version</th><th>state</th><th>since issue</th></tr></thead>
            <tbody>
              {limit(1, ex).map((task) => {
                const version = (c.version as Int32Array)[task]
                const done = (c.complete as Float64Array)[task] <= t
                return (
                  <tr key={task}>
                    <td>{taskCell(task)}</td>
                    <td className="num">{gid[task]}</td>
                    <td className="num">{version >= 0 ? version : ''}</td>
                    <td>{done ? 'done' : 'executing'}</td>
                    <td className="num">{count(t - (c.issue as Float64Array)[task])}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {more(1, ex.length)}
        </>
      )
    },
  }
  const entryList = (table: number) => {
    const e = data.entries?.cols
    if (!e) return <div className="muted">loading…</div>
    const rows = data.entriesAt(node, table, t)
    const base = e.base as Float64Array
    const len = e.len as Float64Array
    const version = e.version as Int32Array
    const egid = e.gid as Int32Array
    const peer = e.peer as Int32Array
    const flags = e.flags as Int32Array
    const start = e.start as Float64Array
    return (
      <>
        <table>
          <thead><tr><th>key</th><th>task</th><th>peer</th><th>age</th><th>flags</th></tr></thead>
          <tbody>
            {limit(table, rows).map((i) => (
              <tr key={i}>
                <td className="mono">0x{base[i].toString(16)}{version[i] >= 0 ? ` v${version[i]}` : ''}{len[i] > 0 ? ` +${count(len[i])} B` : ''}</td>
                <td>{egid[i] >= 0 ? taskCell(index.rowOf(egid[i])) : <span className="muted">none</span>}</td>
                <td>{peer[i] >= 0 ? String(nodes[peer[i]]?.name ?? peer[i]) : ''}</td>
                <td className="num">{count(t - start[i])}</td>
                <td className="muted">{flagText(table, flags[i])}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {more(table, rows.length)}
      </>
    )
  }

  return (
    <div className="node-panel">
      <h3>{String(nodes[node].path)}</h3>
      <div className="muted">t = {cycles(t)} · {span(range.a, range.b)}</div>
      {kindCol && (
        <label className="tool">
          task kind
          <select value={kind} onChange={(e) => setKind(Number(e.target.value))}>
            <option value={-1}>all</option>
            {kindCol.dict.map((k, i) => <option key={k} value={i}>{k}</option>)}
          </select>
        </label>
      )}
      <table className="pressure">
        <thead><tr><th>table</th><th>at t</th><th>average</th><th>peak</th></tr></thead>
        <tbody>
          {TABLES.map((tb) => {
            const v = data.value(node, tb.id, t, range.a, range.b)
            const isOpen = open.has(tb.id)
            return [
              <tr key={tb.id} className={isOpen ? 'open' : undefined} onClick={() => v.recorded && setOpen(toggle(open, tb.id))}>
                <td><span className="fold">{v.recorded ? (isOpen ? '▾' : '▸') : ''}</span>{tb.name}</td>
                {v.recorded ? (
                  <>
                    {v.atRecorded ? <td className="num">{v.cap ? `${v.at} / ${v.cap}` : v.at}</td> : <td className="muted">not recorded</td>}
                    {v.rangeRecorded ? (
                      <>
                        <td className="num">{num(v.average)}{share(v.average, v.cap)}</td>
                        <td className="num">{v.peak}{share(v.peak, v.cap)}</td>
                      </>
                    ) : <td colSpan={2} className="muted">not recorded</td>}
                  </>
                ) : <td colSpan={3} className="muted">not recorded</td>}
              </tr>,
              isOpen && v.recorded && (
                <tr key={`${tb.id}-items`} className="items"><td colSpan={4}>
                  {!v.atRecorded ? <span className="muted">not recorded</span> : v.at === 0 ? <span className="muted">empty at t</span> : tb.id < 2 ? lists[tb.id]() : entryList(tb.id)}
                </td></tr>
              ),
            ]
          })}
        </tbody>
      </table>
    </div>
  )
}

/** The flags of an entry, in words (trace-raw 4.7). */
function flagText(table: number, f: number): string {
  switch (table) {
    case 2: return ['dependency', 'local wait', 'remote Await', '?'][f & 3]
    case 3: return f & 1 ? 'nu.version' : ''
    case 5: return f & 1 ? 'VersionReset' : ''
    case 6: return [f & 1 ? 'registered' : '', f & 2 ? 'rejected' : ''].filter(Boolean).join(', ')
    case 7: return [f & 1 ? 'VersionReset' : '', f & 2 ? 'replayed' : ''].filter(Boolean).join(', ')
    default: return ''
  }
}
