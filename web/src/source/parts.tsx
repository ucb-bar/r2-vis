// Parts of the Source view's rendering: addresses (path and memory muted, offset
// emphasized), code (syntax-colored), unknown parts, per-trip values and trip tables.
import type { ReactNode } from 'react'
import { count } from '../ui/format'
import type { TipContent } from '../ui/Tooltip'
import { tokenizeRust, type Token } from './rust'
import { isPerTrip, splitAddress, tripCount, tripEntries, type Field, type Trips } from './srcmap'

export type Hover = (e: React.MouseEvent, content: TipContent | null) => void

export function tokenSpans(tokens: Token[]): ReactNode {
  return tokens.map((t, k) => (t.kind === 'text' ? t.text : <span key={k} className={`tok-${t.kind}`}>{t.text}</span>))
}

/** A piece of code (an expression), syntax-colored, on one line. */
export function code(text: string): ReactNode {
  return <code className="rd-code">{tokenizeRust(text).map((line, k) => <span key={k}>{k > 0 && ' '}{tokenSpans(line)}</span>)}</code>
}

/** A display text with its `?` parts marked unknown. */
export function unknownParts(text: string): ReactNode {
  if (!text.includes('?')) return text
  return text.split(/(\?)/).map((p, k) => (p === '?' ? <span key={k} className="src-unknown">?</span> : p))
}

/** A per-trip value at a trip index (for the address tooltip). */
export function valueOf(v: Trips<string> | undefined, idx: number[]): string | null {
  if (v === undefined || v === null) return null
  if (!isPerTrip(v)) return v as string
  return tripEntries<string>(v).find((e) => e.idx.join(',') === idx.join(','))?.value ?? null
}

/** An address text as parts (path and memory muted, offset emphasized); its tooltip names
 * the address or the (self) offset of the trip. Text that is not an address stays text. */
export function address(f: Field | null, text: string | null, idx: number[] | null, hover: Hover, clear: () => void): ReactNode {
  if (text === null) return <span className="src-unknown">?</span>
  const parts = splitAddress(text)
  if (!parts) return <span>{unknownParts(text)}</span>
  const tipOf = (): TipContent | null => {
    if (!f || idx === null) return null
    const rows = f.addr !== undefined && f.addr !== null
      ? [{ label: 'addr', value: valueOf(f.addr, idx) ?? '?' }]
      : f.self_offset !== undefined ? [{ label: 'self offset', value: valueOf(f.self_offset, idx) ?? '?' }] : []
    return rows.length ? { title: parts.offset, path: parts.path, sections: [{ kind: 'rows', rows }] } : null
  }
  return (
    <span className="src-addr" onMouseEnter={(e) => hover(e, tipOf())} onMouseLeave={clear}>
      <span className="src-addr-path">{unknownParts(parts.path)}+</span>
      <span className="src-addr-off">{unknownParts(parts.offset)}</span>
      <span className="src-addr-rest">{unknownParts(parts.rest)}</span>
    </span>
  )
}

/** A value that the build could not know: null, or with `?` parts. */
export function unknownValue(v: string | null | undefined): boolean {
  return v === null || v === undefined || v.includes('?')
}

/** "× n": the trips of a per-trip value (a toggle for its trip table). */
export function tripsButton(v: Trips<unknown>, onClick: () => void): ReactNode {
  return <button className="src-trips" onClick={(e) => { e.stopPropagation(); onClick() }}>× {count(tripCount(v))}</button>
}

/** The trip table of a per-trip value: a grid for two levels without links, else a list;
 * `cell` renders one trip. */
export function tripTable(v: Trips<string>, cell: (e: { idx: number[]; value: string | null }) => ReactNode, grid: boolean): ReactNode {
  const entries = tripEntries<string>(v)
  const depth = entries[0]?.idx.length ?? 0
  if (depth === 2 && grid) {
    const rows = Math.max(...entries.map((e) => e.idx[0])) + 1
    const cols = Math.max(...entries.map((e) => e.idx[1])) + 1
    const at = new Map(entries.map((e) => [e.idx.join(','), e]))
    return (
      <table className="src-trip-table">
        <thead><tr><th>i \ j</th>{Array.from({ length: cols }, (_, j) => <th key={j}>{j}</th>)}</tr></thead>
        <tbody>{Array.from({ length: rows }, (_, i) => (
          <tr key={i}><th>{i}</th>{Array.from({ length: cols }, (_, j) => {
            const e = at.get(`${i},${j}`)
            return <td key={j}>{e ? cell(e) : null}</td>
          })}</tr>
        ))}</tbody>
      </table>
    )
  }
  return (
    <table className="src-trip-table">
      <thead><tr><th>{depth > 1 ? ['i', 'j', 'k', 'l'].slice(0, depth).join(', ') : 'i'}</th><th /></tr></thead>
      <tbody>{entries.map((e) => <tr key={e.idx.join(',')}><th>{e.idx.join(', ')}</th><td>{cell(e)}</td></tr>)}</tbody>
    </table>
  )
}
