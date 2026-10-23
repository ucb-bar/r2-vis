// The Source view (r2-toolchain docs/source-map.md, version 1): a Neutrino program from its
// source map, as an outline of its items (left) and its source (right). It fills the
// container it gets.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { SOURCE_OP_SLOT } from '../timeline/colors'
import { count } from '../ui/format'
import { Tooltip, tipPlace, type TipContent } from '../ui/Tooltip'
import { tokenizeRust, type Token } from './rust'
import {
  DepIndex, firstValue, indexProgram, innermostAt, isPerTrip, seenCalls, splitAddress, tripCount, tripEntries,
  type DepLink, type Field, type Node, type SourceMap, type Trips,
} from './srcmap'

interface Props {
  map: SourceMap | null
  name: string
  error?: string | null
  onOpen: (file: File) => void
}

const SPLIT_KEY = 'r2vis.source.split'

function loadSplit(): number {
  try {
    const v = Number(localStorage.getItem(SPLIT_KEY))
    return v > 0.1 && v < 0.9 ? v : 0.45
  } catch {
    return 0.45
  }
}

/** The color slot of an op (the timeline's opcode colors, plus join, spawn, imem_copy). */
const opSlot = (op: string | undefined) => SOURCE_OP_SLOT[op ?? ''] ?? 8
const opColor = (op: string | undefined) => (opSlot(op) === 8 ? 'var(--series-other)' : `var(--series-${opSlot(op) + 1})`)

/** The default fold state: functions, loops and closures open; invokes (their
 * descriptors), scalars and waits closed. */
const openByDefault = (n: Node) => n.item.kind === 'function' || n.item.kind === 'loop' || n.item.kind === 'closure'
const expandable = (n: Node) => n.children.length > 0 || n.item.kind === 'invoke' || n.item.kind === 'scalar' || n.item.kind === 'wait'

export function SourceView({ map, name, error, onOpen }: Props) {
  const [pi, setPi] = useState(0)
  const [sel, setSel] = useState<Map<number, string>>(new Map())
  const [toggled, setToggled] = useState<Set<string>>(new Set())
  const [tables, setTables] = useState<Set<string>>(new Set())
  const [fileIdx, setFileIdx] = useState(0)
  const [split, setSplit] = useState(loadSplit)
  const [tip, setTip] = useState<{ x: number; y: number; content: TipContent } | null>(null)
  const host = useRef<HTMLDivElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const drag = useRef(false)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => { setPi(0); setSel(new Map()); setToggled(new Set()); setTables(new Set()); setFileIdx(0) }, [map])
  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (!drag.current || !body.current) return
      const r = body.current.getBoundingClientRect()
      setSplit(Math.max(0.15, Math.min(0.85, (e.clientX - r.left) / r.width)))
    }
    const up = () => {
      if (!drag.current) return
      drag.current = false
      try { localStorage.setItem(SPLIT_KEY, String(split)) } catch { /* not kept */ }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
  }, [split])

  const program = map?.programs[pi] ?? null
  const index = useMemo(() => (program ? indexProgram(program) : null), [program])
  const deps = useMemo(() => (index ? new DepIndex(index.all, map?.granule) : null), [index, map])
  const tokens = useMemo(() => map?.files.map((f) => tokenizeRust(f.text)) ?? [], [map])
  const selected = index?.byId.get(sel.get(pi) ?? '') ?? null

  const select = (n: Node | null) => {
    setSel((s) => new Map(s).set(pi, n?.id ?? ''))
    if (n) setFileIdx(n.item.file)
  }
  const goProgram = (programName: string) => {
    const k = map?.programs.findIndex((p) => p.program === programName) ?? -1
    if (k < 0) return
    setPi(k)
    setSel((s) => new Map(s).set(k, '0'))
    setFileIdx(map?.programs[k].items[0]?.file ?? 0)
  }
  // The fold and trip-table state, per program (item ids repeat across programs).
  const isOpen = (n: Node) => openByDefault(n) !== toggled.has(`${pi}:${n.id}`)
  const flip = (set: Set<string>, key: string) => { const t = new Set(set); if (t.has(key)) t.delete(key); else t.add(key); return t }
  const toggle = (id: string) => setToggled((s) => flip(s, `${pi}:${id}`))
  const toggleTable = (key: string) => setTables((s) => flip(s, `${pi}:${key}`))
  const tableOpen = (key: string) => tables.has(`${pi}:${key}`)
  const hover = (e: React.MouseEvent, content: TipContent | null) => {
    const r = host.current?.getBoundingClientRect()
    setTip(content && r ? { x: e.clientX - r.left, y: e.clientY - r.top, content } : null)
  }

  const picker = (
    <>
      <button className="button small" onClick={() => input.current?.click()}>Open source map…</button>
      <input ref={input} type="file" accept=".json,application/json" hidden
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onOpen(f); e.target.value = '' }} />
    </>
  )
  if (!map || !program || !index || !deps) {
    return (
      <div className="source-view empty" ref={host}>
        <div className="source-empty">{picker}{error && <div className="error">{error}</div>}</div>
      </div>
    )
  }

  // ---- outline ------------------------------------------------------------------------------
  const firstLine = (n: Node) => map.files[n.item.file]?.text.split('\n')[n.item.lines[0] - 1]?.trim() ?? ''
  const label = (n: Node) => n.item.summary ?? firstLine(n)

  const address = (f: Field, text: string | null, idx: number[] | null): ReactNode => {
    if (text === null) return <span className="src-unknown">?</span>
    const parts = splitAddress(text)
    const where = idx === null ? null : f.addr === null || f.addr === undefined ? valueOf(f.self_offset, idx) : valueOf(f.addr, idx)
    const tipOf = (): TipContent | null => {
      if (!parts) return null
      const rows = f.addr !== undefined && f.addr !== null
        ? [{ label: 'addr', value: where ?? '?' }]
        : f.self_offset !== undefined ? [{ label: 'self offset', value: where ?? '?' }] : []
      return rows.length ? { title: parts.offset, path: parts.path, sections: [{ kind: 'rows', rows }] } : null
    }
    if (!parts) return <span>{unknownParts(text)}</span>
    return (
      <span className="src-addr" onMouseEnter={(e) => hover(e, tipOf())} onMouseLeave={() => setTip(null)}>
        <span className="src-addr-path">{unknownParts(parts.path)}+</span>
        <span className="src-addr-off">{unknownParts(parts.offset)}</span>
        <span className="src-addr-rest">{unknownParts(parts.rest)}</span>
      </span>
    )
  }

  /** A field's value: the first trip and "× n" (a toggle for the trip table), or the value. */
  const fieldValue = (f: Field, key: string): ReactNode => {
    if (!isPerTrip(f.value)) return address(f, (f.value as string | null) ?? null, [])
    const first = tripEntries<string>(f.value).find((e) => e.value !== null)
    return (
      <>
        {first ? address(f, first.value, first.idx) : <span className="src-unknown">?</span>}
        <button className="src-trips" onClick={() => toggleTable(key)}>× {count(tripCount(f.value))}</button>
      </>
    )
  }

  /** The dependency link of a key (its first trip with a link): "from line N". */
  const depLink = (f: Field): ReactNode => {
    const links = deps.resolve(f)
    const first = links.find((l) => l.link)
    if (!first?.link) return null
    return linkButton(first.link, links.length > 1 ? first.idx : null)
  }
  const linkButton = (link: DepLink, keyIdx: number[] | null): ReactNode => (
    <button className="link src-dep" onClick={() => select(link.node)}>
      from line {link.node.item.lines[0]}{link.idx.length ? ` · trip ${link.idx.join(', ')}` : ''}{keyIdx ? ` (trip ${keyIdx.join(', ')})` : ''}
    </button>
  )

  /** The trip table of a per-trip value: a grid for one or two levels, else a list. */
  const tripTable = (f: { value: Trips<string> } & Partial<Field>, withLinks: boolean): ReactNode => {
    const entries = tripEntries<string>(f.value)
    const links = withLinks ? new Map(deps.resolve(f as Field).map((l) => [l.idx.join(','), l.link])) : null
    const cell = (e: { idx: number[]; value: string | null }) => (
      <>
        {e.value === null ? <span className="src-unknown">not run</span> : 'expr' in f ? address(f as Field, e.value, e.idx) : unknownParts(e.value)}
        {links?.get(e.idx.join(',')) && <> {linkButton(links.get(e.idx.join(',')) as DepLink, null)}</>}
      </>
    )
    const depth = entries[0]?.idx.length ?? 0
    if (depth === 2 && !links) {
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

  const exprCell = (expr: string | null) =>
    expr === null ? <td className="src-expr" /> : <td className={expr === '(default)' ? 'src-expr default' : 'src-expr'}>{expr}</td>

  /** The fields of an invoke's descriptor (dst, deps[i], args in file order), then pe,
   * child and pc when they vary or are set. */
  const descriptorRows = (n: Node): ReactNode[] => {
    const d = n.item.descriptor
    const rows: ReactNode[] = []
    const fieldRow = (name: string, f: Field, key: string, isKey: boolean) => {
      rows.push(
        <tr key={key}>
          <td className="src-field">{name}</td>
          {exprCell(f.expr)}
          <td className="src-value">{fieldValue(f, key)}{isKey && !isPerTrip(f.value) && <> {depLink(f)}</>}</td>
        </tr>,
      )
      if (tableOpen(key)) rows.push(<tr key={`${key}-t`} className="src-table-row"><td /><td colSpan={2}>{tripTable(f, isKey)}</td></tr>)
    }
    if (d) {
      fieldRow('dst', d.dst, `${n.id}|dst`, false)
      d.deps.forEach((f, k) => fieldRow(`deps[${k}]`, f, `${n.id}|deps${k}`, true))
      for (const [k, f] of Object.entries(d.args)) fieldRow(k, f, `${n.id}|arg.${k}`, false)
    }
    if (n.item.key) fieldRow('key', n.item.key, `${n.id}|key`, true)
    for (const name of ['pe', 'child', 'pc'] as const) {
      const v = n.item[name]
      if (v === undefined || v === null) continue
      const key = `${n.id}|${name}`
      rows.push(
        <tr key={key} className="src-meta">
          <td className="src-field">{name}</td><td className="src-expr" />
          <td className="src-value">{isPerTrip(v)
            ? <>{firstValue(v as Trips<string>) ?? '?'}<button className="src-trips" onClick={() => toggleTable(key)}>× {count(tripCount(v))}</button></>
            : String(v)}</td>
        </tr>,
      )
      if (tableOpen(key)) rows.push(<tr key={`${key}-t`} className="src-table-row"><td /><td colSpan={2}>{tripTable({ value: v as Trips<string> }, false)}</td></tr>)
    }
    return rows
  }

  const badges = (n: Node): ReactNode => {
    const it = n.item
    const out: ReactNode[] = []
    if (it.untracked) out.push(<span key="u" className="badge">untracked</span>)
    if (it.uncertain) out.push(<span key="c" className="badge warn">uncertain</span>)
    if ((it.kind === 'invoke' || it.kind === 'wait') && it.pc === null) out.push(<span key="n" className="badge muted">not reached</span>)
    return out
  }

  const perTrip = (v: Trips<string> | undefined): ReactNode => {
    if (v === undefined || v === null) return null
    if (!isPerTrip(v)) return v as string
    return <>{firstValue(v) ?? '?'} <span className="src-times">× {count(tripCount(v))}</span></>
  }

  const rowContent = (n: Node): ReactNode => {
    const it = n.item
    switch (it.kind) {
      case 'function':
        return <><span className="src-name">{it.name}</span><span className="src-summary">{it.summary ?? ''}</span></>
      case 'loop':
        return <><span className="src-kind">loop</span><span className="src-count">trips {it.trips ?? '?'}</span><span className="src-summary">{label(n)}</span></>
      case 'closure': {
        return <><span className="src-kind">closure</span>{it.name && <span className="src-name">{it.name}</span>}
          <span className="src-count">calls {it.calls ?? '?'}</span>
          {it.calls === undefined && seenCalls(n) !== null && <span className="src-times">seen {seenCalls(n)}</span>}
          <span className="src-summary">{label(n)}</span></>
      }
      case 'scalar':
        return <span className="src-summary">{label(n)}</span>
      case 'wait': {
        const k = it.key
        const text = k ? firstValue(k.value) : null
        return <>
          <span className="src-kind">wait</span>
          {badges(n)}
          {k && (text === 'fence' ? <span className="src-fence">fence</span> : k.value === null || text === null ? <span className="src-unknown">?</span>
            : <>{address(k, text, tripEntries<string>(k.value).find((e) => e.value !== null)?.idx ?? [])}{isPerTrip(k.value) && <span className="src-times"> × {count(tripCount(k.value))}</span>}</>)}
          {k && depLink(k)}
          <span className="src-summary">{it.summary ?? ''}</span>
        </>
      }
      case 'invoke': {
        const dst = it.descriptor?.dst
        const dstText = dst ? firstValue(dst.value) : null
        return <>
          <span className="src-op" style={{ background: opColor(it.op) }}>{it.op}</span>
          {badges(n)}
          {it.pe !== null && it.pe !== undefined && <span className="src-pe">{perTrip(it.pe)}</span>}
          {it.program && <button className="link src-program" onClick={(e) => { e.stopPropagation(); goProgram(it.program as string) }}>→ {it.program}</button>}
          {it.child !== undefined && it.child !== null && <span className="src-pe">on {perTrip(it.child)}</span>}
          {dst && (dstText === null ? <span className="src-unknown">?</span> : <span className="src-dst">{address(dst, dstText, tripEntries<string>(dst.value).find((e) => e.value !== null)?.idx ?? [])}
            {isPerTrip(dst.value) && <span className="src-times"> × {count(tripCount(dst.value))}</span>}</span>)}
          <span className="src-summary">{it.summary ?? ''}</span>
        </>
      }
    }
  }

  const rowTip = (n: Node): TipContent | null => {
    const text = n.item.kind === 'function' || n.item.kind === 'invoke' || n.item.kind === 'wait' ? n.item.summary : label(n)
    if (!text) return null
    const [a, b] = n.item.lines
    return { title: n.item.op ?? n.item.name ?? n.item.kind, path: a === b ? `line ${a}` : `lines ${a}–${b}`, sections: [{ kind: 'note', text }] }
  }

  const rows: ReactNode[] = []
  const emit = (n: Node) => {
    const open = isOpen(n)
    const canOpen = expandable(n)
    const cls = ['src-row', `kind-${n.item.kind}`, selected?.id === n.id ? 'selected' : ''].join(' ')
    rows.push(
      <div key={n.id} className={cls} style={{ paddingLeft: 8 + n.depth * 16 }} onClick={() => select(n)} data-id={n.id}
        onMouseOver={(e) => { if (!(e.target as Element).closest('.src-addr')) hover(e, rowTip(n)) }} onMouseLeave={() => setTip(null)}>
        <span className="src-fold" onClick={(e) => { e.stopPropagation(); if (canOpen) toggle(n.id) }}>{canOpen ? (open ? '▾' : '▸') : ''}</span>
        {rowContent(n)}
      </div>,
    )
    if (!open) return
    if (n.item.kind === 'invoke' || n.item.kind === 'wait') {
      rows.push(
        <div key={`${n.id}-d`} className="src-desc" style={{ paddingLeft: 24 + n.depth * 16 }}>
          <table><tbody>{descriptorRows(n)}</tbody></table>
        </div>,
      )
    } else if (n.item.kind === 'scalar') {
      const [a, b] = n.item.lines
      rows.push(
        <div key={`${n.id}-s`} className="src-inline" style={{ paddingLeft: 24 + n.depth * 16 }}>
          {Array.from({ length: b - a + 1 }, (_, k) => (
            <div key={k} className="src-line"><span className="src-ln">{a + k}</span><code>{tokenSpans(tokens[n.item.file]?.[a + k - 1] ?? [])}</code></div>
          ))}
        </div>,
      )
    }
    n.children.forEach(emit)
  }
  index.roots.forEach(emit)

  const notes = program.notes ?? []
  return (
    <div className="source-view" ref={host}>
      <div className="source-head">
        <label className="tool">
          program
          <select value={pi} onChange={(e) => { setPi(Number(e.target.value)); setFileIdx(map.programs[Number(e.target.value)].items[0]?.file ?? 0) }}>
            {map.programs.map((p, k) => <option key={p.program} value={k}>{p.program}</option>)}
          </select>
        </label>
        <span className="badge">{program.node}</span>
        <span className="source-meta">{map.config}</span>
        <span className="source-meta">{program.image.elf}</span>
        {notes.length > 0 && (
          <span className="badge warn src-notes" onMouseEnter={(e) => hover(e, { title: 'notes', sections: notes.map((t) => ({ kind: 'note', text: t })) })}
            onMouseLeave={() => setTip(null)}>notes {notes.length}</span>
        )}
        <span className="spacer" />
        <span className="source-meta">{name}</span>
        {picker}
      </div>
      <div className="source-body" ref={body}>
        <div className="source-outline" style={{ flex: `0 0 ${split * 100}%` }}>{rows}</div>
        <div className="source-split" onPointerDown={(e) => { e.preventDefault(); drag.current = true }} />
        <SourcePane map={map} tokens={tokens} index={index.all} file={fileIdx} onFile={setFileIdx}
          selected={selected} onLine={(line) => select(innermostAt(index.all, fileIdx, line))} />
      </div>
      {tip && <Tooltip tip={tip.content} style={tipPlace(tip, host.current)} />}
    </div>
  )
}

/** A per-trip value at a trip index (for the address tooltip). */
function valueOf(v: Trips<string> | undefined, idx: number[]): string | null {
  if (v === undefined || v === null) return null
  if (!isPerTrip(v)) return v as string
  return tripEntries<string>(v).find((e) => e.idx.join(',') === idx.join(','))?.value ?? null
}

/** A display text with its `?` parts marked unknown. */
function unknownParts(text: string): ReactNode {
  if (!text.includes('?')) return text
  return text.split(/(\?)/).map((p, k) => (p === '?' ? <span key={k} className="src-unknown">?</span> : p))
}

function tokenSpans(tokens: Token[]): ReactNode {
  return tokens.map((t, k) => (t.kind === 'text' ? t.text : <span key={k} className={`tok-${t.kind}`}>{t.text}</span>))
}

interface PaneProps {
  map: SourceMap
  tokens: Token[][][]
  index: Node[]
  file: number
  onFile: (f: number) => void
  selected: Node | null
  onLine: (line: number) => void
}

/** The source of one file: line numbers, syntax colors, a mark per invoke line (by op),
 * the selected item's lines highlighted and scrolled into view. */
function SourcePane({ map, tokens, index, file, onFile, selected, onLine }: PaneProps) {
  const scroller = useRef<HTMLDivElement>(null)
  const lines = tokens[file] ?? []
  // per line: the op of the first invoke that covers it
  const marks = useMemo(() => {
    const out = new Map<number, string>()
    for (const n of index) {
      if (n.item.kind !== 'invoke' || n.item.file !== file) continue
      for (let l = n.item.lines[0]; l <= n.item.lines[1]; l++) if (!out.has(l)) out.set(l, n.item.op ?? '')
    }
    return out
  }, [index, file])
  const sel = selected && selected.item.file === file ? selected.item.lines : null
  useEffect(() => {
    if (!sel || !scroller.current) return
    const el = scroller.current.querySelector<HTMLElement>(`[data-line="${sel[0]}"]`)
    const box = scroller.current.getBoundingClientRect()
    const r = el?.getBoundingClientRect()
    if (el && r && (r.top < box.top || r.bottom > box.bottom)) el.scrollIntoView({ block: 'center' })
  }, [sel?.[0], sel?.[1], file])
  return (
    <div className="source-pane">
      {map.files.length > 1 && (
        <div className="source-files">
          <select value={file} onChange={(e) => onFile(Number(e.target.value))}>
            {map.files.map((f, k) => <option key={f.path} value={k}>{f.path}</option>)}
          </select>
        </div>
      )}
      <div className="source-code" ref={scroller}>
        {lines.map((toks, k) => {
          const line = k + 1
          const op = marks.get(line)
          const inSel = sel !== null && line >= sel[0] && line <= sel[1]
          return (
            <div key={k} data-line={line} className={inSel ? 'src-line selected' : 'src-line'} onClick={() => onLine(line)}>
              <span className="src-mark" style={op !== undefined ? { background: opColor(op) } : undefined} />
              <span className="src-ln">{line}</span>
              <code>{tokenSpans(toks)}</code>
            </div>
          )
        })}
      </div>
    </div>
  )
}
