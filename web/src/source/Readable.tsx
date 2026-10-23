// The readable source (Source view, Readable mode): a program's functions in source order,
// one column. Code lines stay code (indentation, syntax colors, line numbers). A region is a
// fold row with its summary. A loop or closure keeps its header and closing lines, with its
// facts as badges on the header. An invoke becomes a card (op, PE, badges, tasks; version,
// dst, mask, deps with their producers, args), a wait a pill with its key. A value that the
// build could not know shows the code of its field.
import type { ReactNode } from 'react'
import { SOURCE_OP_SLOT } from '../timeline/colors'
import { count } from '../ui/format'
import type { Producer } from './links'
import { address, code, tokenSpans, tripsButton, tripTable, unknownValue, type Hover } from './parts'
import type { Token } from './rust'
import {
  firstValue, isPerTrip, seenCalls, tripEntries, type DepIndex, type DepLink, type Field, type Node, type Program, type Trips,
} from './srcmap'

/** The color of an op (the timeline's opcode colors, plus join and spawn). */
export const opColor = (op: string | undefined) => {
  const slot = SOURCE_OP_SLOT[op ?? ''] ?? 8
  return slot === 8 ? 'var(--series-other)' : `var(--series-${slot + 1})`
}

/** The trace's view of the program shown (a matched program instance): an item's tasks and
 * the producers of an invoke's dependency. */
export interface CardLinks {
  tasks: (n: Node) => number[]
  producers: (n: Node, k: number) => Producer[]
}

export interface ReadableProps {
  program: Program
  roots: Node[]
  lines: Token[][]
  file: number
  deps: DepIndex
  selected: string | null
  /** the item selected in another Source area showing this program */
  highlight: string | null
  isOpen: (key: string, dflt: boolean) => boolean
  toggle: (key: string, dflt: boolean) => void
  onSelect: (n: Node) => void
  /** a producer's card (in this program or another) */
  onProducer: (p: Producer) => void
  links: CardLinks | null
  selectTasks: (rows: number[]) => void
  goProgram: (name: string) => void
  hover: Hover
  clear: () => void
}

/** Whether an item holds an invoke or a wait (a region with one is open by default). */
const active = (n: Node): boolean => n.item.kind === 'invoke' || n.item.kind === 'wait' || n.children.some(active)

/** The fold keys: region, card source, deps, args, trip table. */
export const regionKey = (n: Node) => `r:${n.id}`

export function Readable(p: ReadableProps) {
  const { lines, file, deps, isOpen, toggle, hover, clear } = p
  const text = (l: number) => lines[l - 1]
  const indentOf = (l: number) => {
    const raw = (text(l) ?? []).map((t) => t.text).join('')
    const m = /^[ \t]*/.exec(raw)?.[0] ?? ''
    return m.replace(/\t/g, '    ').length
  }
  const rows: ReactNode[] = []
  // Open regions around the rows: their content is indented under the fold row.
  let nest = 0
  const NEST_CH = 2
  const row = (key: string, line: number | null, body: ReactNode, cls = '', indent = 0, extra?: Partial<React.HTMLAttributes<HTMLDivElement>>) => {
    const pad = indent + nest * NEST_CH
    rows.push(
      <div key={key} className={`rd-row ${cls}`.trim()} data-line={line ?? undefined} {...extra}>
        <span className="rd-ln">{line ?? ''}</span>
        <div className="rd-body" style={pad ? { paddingLeft: `${pad}ch` } : undefined}>{body}</div>
      </div>,
    )
  }
  const codeLine = (l: number, badges?: ReactNode) =>
    row(`l${l}`, l, <><code className="rd-src">{tokenSpans(text(l) ?? [])}</code>{badges}</>, 'rd-code-line')

  // ---- values ------------------------------------------------------------------------------
  const exprOrUnknown = (expr: string | null | undefined): ReactNode =>
    expr && expr !== '(default)' ? code(expr) : <span className="src-unknown">?</span>
  /** dst text without its version and mask (they have lines of their own) */
  const bare = (t: string) => t.replace(/\s*@v\S+/, '').replace(/\s*mask \S+/, '')

  /** A field's value: known, the first trip and "× n", else the code of its expression. */
  const value = (f: Field, tkey: string, strip = false): ReactNode => {
    const v = f.value
    const shown = (t: string) => (strip ? bare(t) : t)
    if (isPerTrip(v)) {
      const entries = tripEntries<string>(v)
      if (entries.every((e) => unknownValue(e.value))) return exprOrUnknown(f.expr)
      const first = entries.find((e) => !unknownValue(e.value)) ?? entries[0]
      return <>{address(f, shown(first.value as string), first.idx, hover, clear)}{tripsButton(v, () => toggle(tkey, false))}</>
    }
    if (unknownValue(v as string | null)) return exprOrUnknown(f.expr)
    return address(f, shown(v as string), [], hover, clear)
  }

  /** The trip table of a field (with the static link of each trip for a key). */
  const tableOf = (f: Field, isKey: boolean, strip = false): ReactNode => {
    const links = isKey ? new Map(deps.resolve(f).map((l) => [l.idx.join(','), l.link])) : null
    return tripTable(f.value as Trips<string>, (e) => (
      <>
        {e.value === null ? <span className="src-unknown">not run</span> : address(f, strip ? bare(e.value) : e.value, e.idx, hover, clear)}
        {links?.get(e.idx.join(',')) && <> {staticLink(links.get(e.idx.join(',')) as DepLink, e.idx, true)}</>}
      </>
    ), !links)
  }

  // ---- producers ---------------------------------------------------------------------------
  const tasksLabel = (n: number) => `${count(n)} ${n === 1 ? 'task' : 'tasks'}`
  const producerButton = (key: string, label: ReactNode, onSelect: () => void, tasks: number[] | null) => (
    <button key={key} className="link rd-producer" onClick={(e) => {
      e.stopPropagation()
      if (e.shiftKey && tasks) p.selectTasks(tasks)
      else onSelect()
    }} onMouseEnter={(e) => tasks && hover(e, { title: 'producer', sections: [{ kind: 'note', text: 'click: its card · shift+click: its tasks' }] })}
      onMouseLeave={clear}>
      {label}{tasks ? <span className="rd-count"> · {tasksLabel(tasks.length)}</span> : null}
    </button>
  )
  const nodeLabel = (n: Node) => <>← {n.item.op ?? n.item.kind} line {n.item.lines[0]}</>
  const trip = (idx: number[]) => `trip ${idx.join(', ')}`
  const same = (x: number[], y: number[]) => x.join(',') === y.join(',')
  /** The static link of a key: the invoke whose dst holds it (and its tasks with a trace),
   * with the producer's trip: "same trip" when it is the key's trip (`keyIdx`), "trip i →
   * trip j" when it differs, "trip j" for a key without trips. In a trip table row
   * (`inRow`), the same trip goes without a word. */
  const staticLink = (link: DepLink, keyIdx: number[] | null, inRow = false): ReactNode => {
    let suffix = ''
    if (keyIdx === null) suffix = link.idx.length ? ` · ${trip(link.idx)}` : ''
    else if (same(keyIdx, link.idx)) suffix = inRow ? '' : ' · same trip'
    else suffix = inRow ? ` · ${trip(link.idx)}` : ` · ${trip(keyIdx)} → ${trip(link.idx)}`
    return producerButton(`s${link.node.id}`, <>{nodeLabel(link.node)}{suffix}</>,
      () => p.onSelect(link.node), p.links ? p.links.tasks(link.node) : null)
  }
  /** The static link of a key on its line. A per-trip key: "same trip" when every trip's
   * producer is in the same trip, else the first trip that differs (the trip table lists all). */
  const firstStatic = (f: Field): ReactNode => {
    const links = deps.resolve(f).filter((l) => l.link)
    if (!links.length) return null
    if (!isPerTrip(f.value)) return staticLink(links[0].link as DepLink, null)
    const differ = links.find((l) => !same(l.idx, (l.link as DepLink).idx))
    return differ ? staticLink(differ.link as DepLink, differ.idx) : staticLink(links[0].link as DepLink, links[0].idx)
  }
  /** The producers of dependency k: from the trace when it has them, else the static link. */
  const producers = (n: Node, f: Field, k: number): ReactNode => {
    const fromTrace = p.links?.producers(n, k) ?? []
    if (!fromTrace.length) return firstStatic(f)
    return fromTrace.map((pr, j) => producerButton(`p${j}`,
      pr.node ? nodeLabel(pr.node) : <>← {pr.program}{pr.pc !== null ? ` pc 0x${pr.pc.toString(16)}` : ''}</>,
      () => p.onProducer(pr), pr.tasks))
  }

  // ---- items -------------------------------------------------------------------------------
  const badges = (n: Node): ReactNode[] => {
    const it = n.item
    const out: ReactNode[] = []
    if (it.untracked) out.push(<span key="u" className="badge">untracked</span>)
    if (it.uncertain) out.push(<span key="c" className="badge warn">uncertain</span>)
    if ((it.kind === 'invoke' || it.kind === 'wait') && it.pc === null) out.push(<span key="n" className="badge muted">not reached</span>)
    return out
  }
  const taskCount = (n: Node): ReactNode => {
    if (!p.links) return null
    const tasks = p.links.tasks(n)
    if (!tasks.length) return n.item.kind === 'invoke' && n.item.pc !== null ? <span className="src-times src-tasks">0 tasks</span> : null
    return (
      <button className="link src-tasks" onClick={(e) => { e.stopPropagation(); p.selectTasks(tasks) }}>{tasksLabel(tasks.length)}</button>
    )
  }
  const perTrip = (v: Trips<string> | undefined): ReactNode => {
    if (v === undefined || v === null) return null
    if (!isPerTrip(v)) return v as string
    return <>{firstValue(v) ?? '?'} <span className="src-times">× {count(tripEntries(v).length)}</span></>
  }
  const sourceToggle = (n: Node, raw: boolean) => (
    <button className={raw ? 'rd-toggle active' : 'rd-toggle'} aria-label={raw ? 'show the card' : 'show the source lines'}
      onClick={(e) => { e.stopPropagation(); toggle(`c:${n.id}`, false) }}
      onMouseEnter={(e) => hover(e, { title: raw ? 'Show the card' : 'Show the source lines', sections: [] })} onMouseLeave={clear}>
      <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"
        strokeLinejoin="round" aria-hidden="true"><path d="M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5" /></svg>
    </button>
  )
  const cls = (n: Node, base: string) => [base, p.selected === n.id ? 'selected' : '', p.highlight === n.id ? 'linked' : ''].join(' ').trim()
  /** A name = value line of a card, and its trip table when open. */
  const fieldLines = (out: ReactNode[], name: string, f: Field | null, key: string, body: ReactNode, opts: { isKey?: boolean; strip?: boolean; dim?: boolean } = {}) => {
    out.push(
      <div key={key} className={opts.dim ? 'rd-field dim' : 'rd-field'}>
        <span className="rd-name">{name}</span><span className="rd-eq">=</span><span className="rd-value">{body}</span>
      </div>,
    )
    if (f && isPerTrip(f.value) && isOpen(`t:${key}`, false)) out.push(<div key={`${key}-t`} className="rd-field-table">{tableOf(f, !!opts.isKey, opts.strip)}</div>)
  }

  const card = (n: Node) => {
    const it = n.item
    const [a, b] = it.lines
    const raw = isOpen(`c:${n.id}`, false)
    const indent = indentOf(a)
    if (raw) {
      row(`c${n.id}h`, null, <span className="rd-raw-head">{sourceToggle(n, true)}<span className="src-op" style={{ background: opColor(it.op) }}>{it.op}</span></span>, cls(n, 'rd-raw'), indent,
        { 'data-id': n.id, onClick: () => p.onSelect(n) } as never)
      for (let l = a; l <= b; l++) codeLine(l)
      return
    }
    const d = it.descriptor
    const fields: ReactNode[] = []
    if (d) {
      const dst = d.dst
      if (dst.version !== undefined) {
        const v = dst.version
        const known = isPerTrip(v) ? tripEntries<number>(v).some((e) => e.value !== null) : v !== null
        fieldLines(fields, 'version', null, `${n.id}|version`,
          known ? <>{isPerTrip(v) ? perTrip(v as unknown as Trips<string>) : String(v)}</> : exprOrUnknown(dst.expr))
      }
      fieldLines(fields, 'dst', dst, `${n.id}|dst`, value(dst, `t:${n.id}|dst`, true), { strip: true })
      if (dst.mask !== undefined && !/^0x[fF]+$/.test(dst.mask)) {
        fieldLines(fields, 'mask', null, `${n.id}|mask`, unknownValue(dst.mask) ? exprOrUnknown(dst.expr) : <span className="rd-num">{dst.mask}</span>)
      }
      if (d.deps.length) {
        const open = isOpen(`d:${n.id}`, false)
        fields.push(
          <div key={`${n.id}|deps`} className="rd-field">
            <span className="rd-name"><button className="rd-fold" onClick={(e) => { e.stopPropagation(); toggle(`d:${n.id}`, false) }}>{open ? '▾' : '▸'}</button>deps</span>
            <span className="rd-eq">=</span>
            <span className="rd-value">[{d.deps.length}]{!open && d.deps.length === 1 && <> {producers(n, d.deps[0], 0)}</>}</span>
          </div>,
        )
        if (open) {
          d.deps.forEach((f, k) => fieldLines(fields, `deps[${k}]`, f, `${n.id}|deps${k}`,
            <>{value(f, `t:${n.id}|deps${k}`)} {producers(n, f, k)}</>, { isKey: true }))
        }
      }
      const args = Object.entries(d.args)
      if (args.length) {
        const open = isOpen(`a:${n.id}`, false)
        fields.push(
          <div key={`${n.id}|args`} className="rd-field">
            <span className="rd-name"><button className="rd-fold" onClick={(e) => { e.stopPropagation(); toggle(`a:${n.id}`, false) }}>{open ? '▾' : '▸'}</button>args</span>
            <span className="rd-eq" /><span className="rd-value rd-dim">{args.length}</span>
          </div>,
        )
        if (open) {
          for (const [k, f] of args) {
            fieldLines(fields, k, f, `${n.id}|arg.${k}`, value(f, `t:${n.id}|arg.${k}`), { dim: f.expr === '(default)' })
          }
        }
      }
    }
    row(`c${n.id}`, a, (
      <div className={cls(n, 'rd-card')} data-id={n.id} onClick={() => p.onSelect(n)}>
        <div className="rd-card-head">
          <span className="src-op" style={{ background: opColor(it.op) }}>{it.op}</span>
          {it.pe !== null && it.pe !== undefined && <span className="src-pe">{perTrip(it.pe)}</span>}
          {badges(n)}
          {taskCount(n)}
          {it.program && <button className="link src-program" onClick={(e) => { e.stopPropagation(); p.goProgram(it.program as string) }}>→ {it.program}</button>}
          {it.child !== undefined && it.child !== null && <span className="src-pe">on {perTrip(it.child)}</span>}
          <span className="spacer" />
          {sourceToggle(n, false)}
        </div>
        {fields.length > 0 && <div className="rd-fields">{fields}</div>}
      </div>
    ), '', indent)
  }

  const wait = (n: Node) => {
    const it = n.item
    const [a, b] = it.lines
    const raw = isOpen(`c:${n.id}`, false)
    const indent = indentOf(a)
    if (raw) {
      row(`w${n.id}h`, null, <span className="rd-raw-head">{sourceToggle(n, true)}<span className="rd-wait">wait</span></span>, cls(n, 'rd-raw'), indent,
        { 'data-id': n.id, onClick: () => p.onSelect(n) } as never)
      for (let l = a; l <= b; l++) codeLine(l)
      return
    }
    const k = it.key
    const fence = k && firstValue(k.value) === 'fence'
    const table = k && isPerTrip(k.value) && isOpen(`t:${n.id}|key`, false)
    row(`w${n.id}`, a, (
      <div className={cls(n, 'rd-wait-row')} data-id={n.id} onClick={() => p.onSelect(n)}>
        <span className="rd-wait">wait</span>
        {k && (fence ? <span className="src-fence">fence</span> : value(k, `t:${n.id}|key`))}
        {k && !fence && firstStatic(k)}
        {badges(n)}
        {taskCount(n)}
        <span className="spacer" />
        {sourceToggle(n, false)}
        {table && <div className="rd-field-table">{tableOf(k, true)}</div>}
      </div>
    ), '', indent)
  }

  /** The lines a..b of a container: its children in place of their lines, other lines as code. */
  const range = (children: Node[], a: number, b: number) => {
    const kids = children.filter((c) => c.item.file === file).sort((x, y) => x.item.lines[0] - y.item.lines[0])
    let l = a
    for (let i = 0; i < kids.length;) {
      const group = [kids[i]]
      let end = kids[i].item.lines[1]
      let j = i + 1
      while (j < kids.length && kids[j].item.lines[0] <= end) { group.push(kids[j]); end = Math.max(end, kids[j].item.lines[1]); j++ }
      for (; l < group[0].item.lines[0] && l <= b; l++) codeLine(l)
      group.forEach(item)
      l = Math.max(l, end + 1)
      i = j
    }
    for (; l <= b; l++) codeLine(l)
  }

  const facts = (n: Node): ReactNode => {
    const it = n.item
    if (it.kind === 'loop') return <span className="rd-facts"><span className="badge muted">trips {it.trips ?? '?'}</span></span>
    if (it.kind === 'closure') {
      const seen = it.calls === undefined ? seenCalls(n) : null
      return <span className="rd-facts"><span className="badge muted">calls {it.calls ?? '?'}</span>{seen !== null && <span className="badge muted">seen {seen}</span>}</span>
    }
    return null
  }

  const container = (n: Node) => {
    const [a, b] = n.item.lines
    codeLine(a, facts(n))
    if (b > a) {
      range(n.children, a + 1, b - 1)
      codeLine(b)
    } else range(n.children, a + 1, a)
  }

  /** A region without a summary: its first code line (not a comment), trimmed. */
  const firstCode = (n: Node): string => {
    const raw = (l: number) => (text(l) ?? []).map((t) => t.text).join('').trim()
    for (let l = n.item.lines[0]; l <= n.item.lines[1]; l++) {
      const t = raw(l)
      if (t && !t.startsWith('//')) return t
    }
    return ''
  }

  const region = (n: Node) => {
    const [a, b] = n.item.lines
    const open = isOpen(regionKey(n), active(n))
    const raw = (l: number) => (text(l) ?? []).map((t) => t.text).join('')
    const from = /\/\/\s*region\b/.test(raw(a)) ? a + 1 : a
    const to = /\/\/\s*endregion\b/.test(raw(b)) ? b - 1 : b
    row(`r${n.id}`, a, (
      <div className={cls(n, 'rd-region')} data-id={n.id} onClick={() => toggle(regionKey(n), active(n))}>
        <span className="rd-fold">{open ? '▾' : '▸'}</span>{n.item.summary ? <span className="rd-summary">{n.item.summary}</span>
          : <code className="rd-summary rd-dim rd-src">{firstCode(n)}</code>}
      </div>
    ), '', indentOf(a))
    if (!open) return
    nest++
    range(n.children, from, to)
    nest--
  }

  function item(n: Node) {
    switch (n.item.kind) {
      case 'invoke': card(n); break
      case 'wait': wait(n); break
      case 'region': region(n); break
      case 'scalar': range(n.children, n.item.lines[0], n.item.lines[1]); break
      default: container(n)
    }
  }

  // The top-level items of the file in source order, each with the doc comments and
  // attributes just above it, separated by thin rules.
  const tops = p.roots.filter((n) => n.item.file === file).sort((x, y) => x.item.lines[0] - y.item.lines[0])
  tops.forEach((n, k) => {
    if (k > 0) rows.push(<div key={`sep${n.id}`} className="rd-sep" />)
    let a = n.item.lines[0]
    while (a > 1 && /^\s*(\/\/\/|\/\/!|#\[)/.test((text(a - 1) ?? []).map((t) => t.text).join(''))) a--
    for (let l = a; l < n.item.lines[0]; l++) codeLine(l)
    item(n)
  })
  return <>{rows}</>
}
