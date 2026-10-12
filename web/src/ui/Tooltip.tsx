// The tooltip of every view (views-design 8): a title with the parent path muted, then
// sections separated by thin rules: label/value rows, lists with share bars, small tables.
import type { CSSProperties } from 'react'

/** A label and a value (right-aligned, with its unit), and an optional second value. */
export interface TipRow {
  label: string
  value: string
  extra?: string
}

/** A list row: a share bar (0..1), the name, the value and an optional muted note. */
export interface TipItem {
  share: number
  name: string
  value: string
  note?: string
}

export type TipSection =
  | { kind: 'rows'; rows: TipRow[] }
  | { kind: 'list'; title: string; aside?: string; items: TipItem[]; more: number }
  | { kind: 'table'; title?: string; head: string[]; rows: string[][] }
  | { kind: 'note'; text: string }

export interface TipContent {
  title: string
  /** the parent path, muted */
  path?: string
  /** a muted line under the title (ids) */
  sub?: string
  sections: TipSection[]
}

/** Where a tooltip goes in its container: right of and below the pointer, flipped to the
 * left or above near the container's right or bottom edge. */
export function tipPlace(p: { x: number; y: number }, host: HTMLElement | null): CSSProperties {
  const w = host?.clientWidth ?? Infinity
  const h = host?.clientHeight ?? Infinity
  const left = p.x < w - 360
  const down = p.y < h - 240
  return { left: left ? p.x + 14 : undefined, right: left ? undefined : w - p.x + 14,
    top: down ? p.y + 14 : undefined, bottom: down ? undefined : h - p.y + 14 }
}

/** The most list rows before "+N more". */
export const TIP_ITEMS = 6

/** A list section from (share, name, value, note) items, the first TIP_ITEMS of `total`. */
export function tipList(title: string, items: TipItem[], total: number, aside?: string): TipSection {
  return { kind: 'list', title, aside, items: items.slice(0, TIP_ITEMS), more: Math.max(0, total - TIP_ITEMS) }
}

export function Tooltip({ tip, style, className }: { tip: TipContent; style?: CSSProperties; className?: string }) {
  return (
    <div className={className ? `tooltip ${className}` : 'tooltip'} style={style}>
      <div className="tip-head">
        <span className="tip-title">{tip.title}</span>
        {tip.path && <span className="tip-path">{tip.path}</span>}
      </div>
      {tip.sub && <div className="tip-sub">{tip.sub}</div>}
      {tip.sections.map((s, i) => <Section key={i} s={s} />)}
    </div>
  )
}

function Section({ s }: { s: TipSection }) {
  if (s.kind === 'note') return <div className="tip-section tip-note">{s.text}</div>
  if (s.kind === 'rows') {
    return (
      <div className="tip-section tip-grid">
        {s.rows.map((r, i) => (
          <div key={i} className="tip-row">
            <span className="tip-label">{r.label}</span>
            <span className="tip-value">{r.value}</span>
            <span className="tip-extra">{r.extra ?? ''}</span>
          </div>
        ))}
      </div>
    )
  }
  if (s.kind === 'list') {
    return (
      <div className="tip-section">
        <div className="tip-caption"><span>{s.title}</span>{s.aside && <span className="tip-aside">{s.aside}</span>}</div>
        <div className="tip-list">
          {s.items.map((it, i) => (
            <div key={i} className="tip-item">
              <span className="tip-bar"><span style={{ width: `${Math.max(0, Math.min(1, it.share)) * 100}%` }} /></span>
              <span className="tip-name">{it.name}</span>
              <span className="tip-value">{it.value}</span>
              <span className="tip-extra">{it.note ?? ''}</span>
            </div>
          ))}
        </div>
        {s.more > 0 && <div className="tip-more">+{s.more.toLocaleString('en-US')} more</div>}
      </div>
    )
  }
  return (
    <div className="tip-section">
      {s.title && <div className="tip-caption"><span>{s.title}</span></div>}
      <table className="tip-table">
        <thead><tr>{s.head.map((h, i) => <th key={i}>{h}</th>)}</tr></thead>
        <tbody>{s.rows.map((r, i) => <tr key={i}>{r.map((c, k) => <td key={k}>{c}</td>)}</tr>)}</tbody>
      </table>
    </div>
  )
}
