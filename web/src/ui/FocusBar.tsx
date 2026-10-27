// The focus bar (state/focusctl.ts): one chip per part of the focus that has content, in
// the workspace tab row. A part set by a gesture is solid, a derived part muted, a part
// being computed shows "…". × on a chip clears that part; Esc clears the focus. The
// tooltip of a chip lists its content.
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { taskName } from '../data/labels'
import type { Trace } from '../data/trace'
import { programIndex, type LoadedMap } from '../source/links'
import { EMPTY_FOCUS, PART_NAMES, type Focus, type FocusItem, type PartName } from '../state/focus'
import type { ViewStore } from '../state/viewstore'
import { count, cycles } from './format'
import { TIP_ITEMS, Tooltip, type TipContent } from './Tooltip'

/** The ends of a range: in cycles below 100k, else in k or M cycles with two significant
 * digits of its width: 137–1,884, 1.2M–1.8M. */
function rangeLabel(a: number, b: number): string {
  if (b < 1e5) return `${cycles(a)}–${cycles(b)}`
  const [unit, s] = b >= 1e6 ? [1e6, 'M'] : [1e3, 'k']
  const width = (b - a) / unit
  const d = width > 0 ? Math.max(0, Math.min(6, 1 - Math.floor(Math.log10(width)))) : 0
  const end = (t: number) => (Number((t / unit).toFixed(d)) === 0 ? '0' : `${(t / unit).toFixed(d)}${s}`)
  return `${end(a)}–${end(b)}`
}

/** An item's name: its program and first line, or its id when no loaded map has it. */
function itemName(maps: LoadedMap[], it: FocusItem): string {
  const p = maps.find((m) => m.name === it.map)?.map.programs.find((q) => q.program === it.program)
  const n = p ? programIndex(p).byId.get(it.id) : undefined
  return n ? `${it.program} line ${n.item.lines[0]}` : `${it.program} ${it.id}`
}

const plural = (n: number, one: string, many: string) => `${count(n)} ${n === 1 ? one : many}`

interface Chip { part: PartName; label: string; tip: TipContent }

function chips(f: Focus, trace: Trace, maps: LoadedMap[]): Chip[] {
  const out: Chip[] = []
  const list = (title: string, names: string[], total: number): TipContent => ({ title,
    sections: [{ kind: 'rows', rows: names.slice(0, TIP_ITEMS).map((n) => ({ label: n, value: '' })) },
      ...(total > TIP_ITEMS ? [{ kind: 'note' as const, text: `+${(total - TIP_ITEMS).toLocaleString('en-US')} more` }] : [])] })
  const items = f.items ?? []
  const oneItem = items.length === 1 ? itemName(maps, items[0]) : null
  for (const part of PART_NAMES) {
    if (f.pending.has(part)) { out.push({ part, label: '…', tip: { title: `${part}: computing`, sections: [] } }); continue }
    if (part === 'items' && items.length) {
      out.push({ part, label: oneItem ?? plural(items.length, 'source item', 'source items'),
        tip: list(plural(items.length, 'source item', 'source items'), items.slice(0, TIP_ITEMS).map((i) => itemName(maps, i)), items.length) })
    } else if (part === 'tasks' && f.tasks?.length) {
      const n = f.tasks.length
      const label = n === 1 ? taskName(trace, f.tasks[0]) : `${plural(n, 'task', 'tasks')}${oneItem ? ` · ${oneItem}` : ''}`
      out.push({ part, label, tip: list(plural(n, 'task', 'tasks'), f.tasks.slice(0, TIP_ITEMS).map((t) => taskName(trace, t)), n) })
    } else if (part === 'time' && f.time) {
      const t = f.time
      out.push({ part, label: 't' in t ? `t = ${cycles(t.t)}` : `range ${rangeLabel(t.a, t.b)}`,
        tip: { title: 't' in t ? 'instant' : 'range', sections: [{ kind: 'rows', rows: 't' in t
          ? [{ label: 't', value: `${cycles(t.t)} cycles` }]
          : [{ label: 'from', value: cycles(t.a) }, { label: 'to', value: cycles(t.b) }, { label: 'span', value: `${cycles(t.b - t.a)} cycles` }] }] } })
    } else if (part === 'resources' && f.resources?.length) {
      const names = f.resources.slice(0, TIP_ITEMS).map((r) => String(trace.dims.resources[r]?.name ?? r))
      const n = f.resources.length
      out.push({ part, label: n === 1 ? names[0] : plural(n, 'resource', 'resources'), tip: list(plural(n, 'resource', 'resources'), names, n) })
    }
  }
  return out
}

export function FocusBar({ store, trace }: { store: ViewStore; trace: Trace }) {
  const focus = useSyncExternalStore((cb) => store.focus.subscribe(cb), () => store.focus.get() ?? EMPTY_FOCUS)
  const maps = useSyncExternalStore((cb) => store.sourceMaps.subscribe(cb), () => store.sourceMaps.get())
  const [tip, setTip] = useState<{ part: PartName; left: number } | null>(null)
  const list = useMemo(() => chips(focus, trace, maps), [focus, trace, maps])

  useEffect(() => {
    // Esc clears the focus (not while typing).
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return
      store.focus.clear()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [store])

  const shown = tip ? list.find((c) => c.part === tip.part) : undefined
  return (
    <div className="focus-bar">
      {list.map((c) => {
        const cls = ['chip', 'focus-chip', focus.fixed.has(c.part) ? '' : 'derived', focus.pending.has(c.part) ? 'pending' : ''].join(' ').trim()
        return (
          <span key={c.part} className={cls} data-part={c.part}
            onMouseEnter={(e) => {
              const bar = e.currentTarget.parentElement?.getBoundingClientRect()
              setTip({ part: c.part, left: e.currentTarget.getBoundingClientRect().left - (bar?.left ?? 0) })
            }}
            onMouseLeave={() => setTip(null)}>
            {c.label}
            <button className="chip-x" aria-label={`clear ${c.part}`} onClick={() => { setTip(null); store.focus.clearPart(c.part) }}>×</button>
          </span>
        )
      })}
      {shown && tip && <Tooltip tip={shown.tip} className="tip-under" style={{ left: tip.left }} />}
    </div>
  )
}
