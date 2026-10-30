// The readable source (Source view, Readable mode): a program's functions in source order,
// one column. Code lines stay code (indentation, syntax colors, line numbers). A region is a
// fold row with its summary. A loop or closure keeps its header and closing lines, with its
// facts as badges on the header. An invoke becomes a card (op, PE, badges, tasks; version,
// dst, mask, deps with their producers, args), a wait a pill with its key. A value that the
// build could not know shows the code of its field.
import type { ReactNode } from 'react'
import { SOURCE_OP_SLOT } from '../timeline/colors'
import { count } from '../ui/format'
import type { MapProgram, Producer, TaskGroup } from './links'
import { address, code, ranTrips, tokenSpans, tripsButton, tripTable, unknownValue, type Hover } from './parts'
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
  /** the item's tasks by call line and by the statement that spawned their program start */
  groups: (n: Node) => { byCall: TaskGroup[]; byStart: TaskGroup[] }
  /** a call item: the tasks that came through it, and the helper or closure it calls */
  viaCall: (n: Node) => number[]
  callee: (n: Node) => Node | null
  /** the region around a line (its marker text), and the calls made in inlined functions by
   * the line of the call in the innermost one */
  region: (line: number) => string | null
  inlinedCalls: Map<number, Node[]>
}

/** "1 task", "12k tasks". */
const tasksLabel = (n: number) => `${count(n)} ${n === 1 ? 'task' : 'tasks'}`

/** The most characters of a region's text in a call marker. */
const MARKER_REGION_CHARS = 40

/** A call item's marker: what it calls (a link to it); for a call made in inlined functions,
 * the innermost one, the line of the call there and its region; the tasks that came through
 * it (a click puts them into the focus). */
export function CallMarker({ call, links, onSelect, focus }: { call: Node; links: CardLinks | null; onSelect: (n: Node) => void;
  focus: (target: { tasks: number[] }, additive: boolean) => void }) {
  const target = links?.callee(call) ?? null
  const via = links?.viaCall(call) ?? []
  const name = call.item.function ?? target?.item.name ?? 'closure'
  const f = call.item.inlined?.[call.item.inlined.length - 1]
  const region = f ? links?.region(f.line) ?? null : null
  const short = region && region.length > MARKER_REGION_CHARS ? `${region.slice(0, MARKER_REGION_CHARS - 1)}…` : region
  return (
    <span className="rd-call-marker" data-id={call.id} title={region ?? undefined}>
      <button className="link" onClick={(e) => { e.stopPropagation(); if (target) onSelect(target) }}>
        → {name}{f ? ` · ${f.function} ${f.line}` : ''}{short ? ` (${short})` : ''}
      </button>
      {call.item.tail && <span className="badge muted">tail</span>}
      {via.length > 0 && <button className="link src-tasks" onClick={(e) => { e.stopPropagation(); focus({ tasks: via }, e.shiftKey) }}>{tasksLabel(via.length)}</button>}
    </span>
  )
}

export interface ReadableProps {
  program: Program
  roots: Node[]
  lines: Token[][]
  file: number
  deps: DepIndex
  /** the focus items of this program: set by a gesture (selected), derived (highlight) */
  selected: ReadonlySet<string>
  highlight: ReadonlySet<string>
  isOpen: (key: string, dflt: boolean) => boolean
  toggle: (key: string, dflt: boolean) => void
  /** an item clicked (with the event: an invoke or wait card) or shown by a link */
  onSelect: (n: Node, e?: React.MouseEvent) => void
  /** a producer's card (in this program or another) */
  onProducer: (p: Producer) => void
  links: CardLinks | null
  /** an item into the focus (`mp`: of another program), or tasks without an item;
   * `additive` adds or removes it */
  focus: (target: { node: Node; mp?: MapProgram } | { tasks: number[] }, additive: boolean) => void
  goProgram: (name: string) => void
  /** shows a line of the file (its regions opened) and marks it */
  goLine: (line: number) => void
  /** the line marked by goLine */
  markLine: number | null
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
  // The closures' calling lines: line -> (closure, its calls from that line).
  const callers = new Map<number, { node: Node; calls: number[] }[]>()
  const visit = (n: Node) => {
    n.item.call_lines?.forEach((l, i) => {
      if (l === null || n.item.file !== file) return
      const at = callers.get(l) ?? []
      const e = at.find((x) => x.node === n)
      if (e) e.calls.push(i)
      else at.push({ node: n, calls: [i] })
      callers.set(l, at)
    })
    n.children.forEach(visit)
  }
  p.roots.forEach(visit)
  /** "27 calls: 1, 5, 9, … 105": the first few calls and the last. */
  const callIndices = (calls: number[]) => (calls.length > 4 ? `${calls.slice(0, 3).join(', ')}, … ${calls[calls.length - 1]}` : calls.join(', '))
  const callsLabel = (calls: number[]) => `${count(calls.length)} ${calls.length === 1 ? 'call' : 'calls'}`
  // the calls made at a line of an inlined function (its source shows the call there)
  const inlinedAt = (l: number) => p.links?.inlinedCalls.get(l)?.filter((c) => c.item.inlined?.[c.item.inlined.length - 1]?.file === file)
    .map((c) => <CallMarker key={`i${c.id}`} call={c} links={p.links} onSelect={p.onSelect} focus={p.focus} />)
  const codeLine = (l: number, badges?: ReactNode, selected?: Node, calls?: ReactNode) =>
    row(`l${l}`, l, <>
      <code className="rd-src">{tokenSpans(text(l) ?? [])}</code>{badges}{inlinedAt(l)}
      {calls ?? callers.get(l)?.map((c) => (
        <button key={c.node.id} className="link rd-call-marker" onClick={(e) => { e.stopPropagation(); p.onSelect(c.node) }}>
          → {c.node.item.name ?? 'closure'} · {callsLabel(c.calls)}
        </button>
      ))}
    </>, ['rd-code-line', p.markLine === l ? 'marked' : '', selected && p.selected.has(selected.id) ? 'selected' : ''].join(' ').trim(),
    0, selected ? { 'data-id': selected.id } as never : undefined)

  // ---- values ------------------------------------------------------------------------------
  const exprOrUnknown = (expr: string | null | undefined): ReactNode =>
    expr && expr !== '(default)' ? code(expr) : <span className="src-unknown">?</span>
  /** dst text without its version and mask (they have lines of their own) */
  const bare = (t: string) => t.replace(/\s*@v\S+/, '').replace(/\s*mask \S+/, '')

  /** A field's value: known, the first trip and "× n", else the code of its expression. */
  const value = (f: Field, tkey: string, strip = false): ReactNode => {
    const v = f.value
    const shown = (t: string) => (strip ? bare(t) : t)
    // unknown: on the text shown (a dst whose only unknown part is its version is known)
    const unknown = (t: string | null) => unknownValue(t === null ? null : shown(t))
    if (isPerTrip(v)) {
      const entries = tripEntries<string>(v)
      if (entries.every((e) => unknown(e.value))) return exprOrUnknown(f.expr)
      const first = entries.find((e) => !unknown(e.value)) ?? entries[0]
      return <>{address(f, shown(first.value as string), first.idx, hover, clear)}{tripsButton(v, () => toggle(tkey, false))}</>
    }
    if (unknown(v as string | null)) return exprOrUnknown(f.expr)
    return address(f, shown(v as string), [], hover, clear)
  }

  /** The rows of a trip table for an item inside closures: "call i · line N". */
  let levels: Node[] = []
  /** the item whose fields are rendered (its keys resolve to producers in its own loops) */
  let current: Node | undefined
  const tripLabel = (level: number, i: number): string => {
    const lv = levels[level]
    const line = lv?.item.call_lines?.[i]
    return lv?.item.kind === 'closure' && line !== undefined && line !== null ? `call ${i} · line ${line}` : String(i)
  }
  /** The trip table of a field (with the static link of each trip for a key). */
  const tableOf = (f: Field, isKey: boolean, strip = false): ReactNode => {
    const links = isKey ? new Map(deps.resolve(f, current).map((l) => [l.idx.join(','), l.link])) : null
    return tripTable(f.value as Trips<string>, (e) => (
      <>
        {e.value === null ? <span className="src-unknown">not run</span> : address(f, strip ? bare(e.value) : e.value, e.idx, hover, clear)}
        {links?.get(e.idx.join(',')) && <> {staticLink(links.get(e.idx.join(',')) as DepLink, e.idx, true)}</>}
      </>
    ), !links, tripLabel)
  }

  // ---- producers ---------------------------------------------------------------------------
  const producerButton = (key: string, label: ReactNode, onSelect: () => void, tasks: number[] | null,
    item: { node: Node; mp?: MapProgram } | null) => (
    <button key={key} className="link rd-producer" onClick={(e) => {
      e.stopPropagation()
      if (e.shiftKey && (item || tasks)) p.focus(item ?? { tasks: tasks as number[] }, true)
      else onSelect()
    }} onMouseEnter={(e) => tasks && hover(e, { title: 'producer', sections: [{ kind: 'note', text: 'click: its card · shift+click: add it to the selection' }] })}
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
    if (keyIdx === null || link.idx.length < keyIdx.length) {
      // a key outside loops, or a producer in fewer loops (an outer loop): its own trip only
      suffix = link.idx.length ? ` · ${trip(link.idx)}` : ''
    } else if (same(keyIdx, link.idx)) suffix = inRow ? '' : ' · same trip'
    else suffix = inRow ? ` · ${trip(link.idx)}` : ` · ${trip(keyIdx)} → ${trip(link.idx)}`
    return producerButton(`s${link.node.id}`, <>{nodeLabel(link.node)}{suffix}</>,
      () => { p.onSelect(link.node); p.focus({ node: link.node }, false) }, p.links ? p.links.tasks(link.node) : null, { node: link.node })
  }
  /** The static link of a key on its line. A per-trip key: "same trip" when every trip's
   * producer is in the same trip, else the first trip that differs (the trip table lists all). */
  const firstStatic = (f: Field): ReactNode => {
    const links = deps.resolve(f, current).filter((l) => l.link)
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
      () => p.onProducer(pr), pr.tasks, pr.node && pr.mp ? { node: pr.node, mp: pr.mp } : null))
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
  /** The groups of an item's tasks (by call line, by the statement that spawned their
   * program start), one row each when there is more than one group: a click puts a group's
   * tasks into the focus. */
  const groupRows = (n: Node): ReactNode => {
    if (!p.links) return null
    const { byCall, byStart } = p.links.groups(n)
    // a group: its line and that line's source text; the region around it in the tooltip, and
    // also shown when the groups' source texts are all the same and each group has a region
    // of its own (the calls of one statement, made in an inlined function)
    const groupRow = (name: string, groups: TaskGroup[]) => {
      if (!groups.length) return null
      const regions = new Set(groups.map((g) => g.label))
      const sameSource = new Set(groups.map((g) => g.source)).size === 1 && regions.size === groups.length && !regions.has(null)
      const short = (r: string) => (r.length > MARKER_REGION_CHARS ? `${r.slice(0, MARKER_REGION_CHARS - 1)}…` : r)
      return (
        <div className="rd-groups" key={name}>
          <span className="rd-groups-name">{name}</span>
          {groups.map((g) => (
            <button key={g.key} className="link rd-group" title={g.label ?? undefined}
              onClick={(e) => { e.stopPropagation(); p.focus({ tasks: g.tasks }, e.shiftKey) }}>
              {g.lines.length ? `line ${g.lines.join(' → ')}` : 'line ?'}
              {g.source && <code className="rd-group-src">{g.source}</code>}
              {sameSource && g.label && <span className="rd-group-region"> ({short(g.label)})</span>}
              <span className="rd-group-n">{count(g.tasks.length)}</span>
            </button>
          ))}
        </div>
      )
    }
    const rows = [groupRow('by call', byCall), groupRow('by start', byStart)].filter(Boolean)
    return rows.length ? <div className="rd-group-rows">{rows}</div> : null
  }
  const taskCount = (n: Node): ReactNode => {
    if (!p.links) return null
    const tasks = p.links.tasks(n)
    if (!tasks.length) return n.item.kind === 'invoke' && n.item.pc !== null ? <span className="src-times src-tasks">0 tasks</span> : null
    return (
      <button className="link src-tasks" onClick={(e) => { e.stopPropagation(); p.focus({ node: n }, e.shiftKey) }}>{tasksLabel(tasks.length)}</button>
    )
  }
  const perTrip = (v: Trips<string> | undefined): ReactNode => {
    if (v === undefined || v === null) return null
    if (!isPerTrip(v)) return v as string
    return <>{firstValue(v) ?? '?'} <span className="src-times">× {count(ranTrips(v))}</span></>
  }
  const sourceToggle = (n: Node, raw: boolean) => (
    <button className={raw ? 'rd-toggle active' : 'rd-toggle'} aria-label={raw ? 'show the card' : 'show the source lines'}
      onClick={(e) => { e.stopPropagation(); toggle(`c:${n.id}`, false) }}
      onMouseEnter={(e) => hover(e, { title: raw ? 'Show the card' : 'Show the source lines', sections: [] })} onMouseLeave={clear}>
      <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"
        strokeLinejoin="round" aria-hidden="true"><path d="M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5" /></svg>
    </button>
  )
  const cls = (n: Node, base: string) => [base, p.selected.has(n.id) ? 'selected' : '', p.highlight.has(n.id) ? 'linked' : ''].join(' ').trim()
  /** A name = value line of a card, and its trip table when open. */
  const fieldLines = (out: ReactNode[], name: string, f: Field | null, key: string, body: ReactNode, opts: { isKey?: boolean; strip?: boolean; dim?: boolean } = {}) => {
    out.push(
      <div key={key} className={opts.dim ? 'rd-field dim' : 'rd-field'}>
        <span className="rd-name">{name}</span><span className="rd-eq">=</span><span className="rd-value">{body}</span>
      </div>,
    )
    if (f && isPerTrip(f.value) && isOpen(`t:${key}`, false)) out.push(<div key={`${key}-t`} className="rd-field-table">{tableOf(f, !!opts.isKey, opts.strip)}</div>)
  }

  /** The op of an invoke, colored; an op the build does not know (an instruction group the
   * dry run never reached): a neutral chip. */
  const opChip = (op: string | null | undefined): ReactNode => (op
    ? <span className="src-op" style={{ background: opColor(op) }}>{op}</span>
    : <span className="badge muted">op unknown</span>)
  const card = (n: Node) => {
    const it = n.item
    levels = n.levels
    current = n
    const [a, b] = it.lines
    const raw = isOpen(`c:${n.id}`, false)
    const indent = indentOf(a)
    if (raw) {
      row(`c${n.id}h`, null, <span className="rd-raw-head">{sourceToggle(n, true)}{opChip(it.op)}</span>, cls(n, 'rd-raw'), indent,
        { 'data-id': n.id, onClick: (e: React.MouseEvent) => p.onSelect(n, e) } as never)
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
        // An unknown version (a range of another node: its owner assigns it) has no code.
        fieldLines(fields, 'version', null, `${n.id}|version`,
          known ? <>{isPerTrip(v) ? perTrip(v as unknown as Trips<string>) : String(v)}</> : <span className="src-unknown">?</span>)
      }
      // an item that the dry run never reached and whose build knows nothing of it (version 2:
      // op null): no dst row
      if (dst.expr !== null || dst.value !== null) fieldLines(fields, 'dst', dst, `${n.id}|dst`, value(dst, `t:${n.id}|dst`, true), { strip: true })
      // The mask (per trip in a loop): shown when it is not all ones.
      const masks = tripEntries<string>(dst.mask as Trips<string> | undefined).map((e) => e.value).filter((m) => m !== null)
      if (masks.some((m) => !/^0x[fF]+$/.test(m))) {
        const mask: Field = { expr: dst.expr, value: dst.mask as Trips<string> }
        fieldLines(fields, 'mask', mask, `${n.id}|mask`, value(mask, `t:${n.id}|mask`))
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
    // A spawn: the started program's arguments, by field of its args struct.
    const childArgs = Object.entries(it.child_args ?? {})
    if (childArgs.length) {
      const open = isOpen(`g:${n.id}`, false)
      fields.push(
        <div key={`${n.id}|child`} className="rd-field">
          <span className="rd-name"><button className="rd-fold" onClick={(e) => { e.stopPropagation(); toggle(`g:${n.id}`, false) }}>{open ? '▾' : '▸'}</button>
            args of {it.program ?? 'the program'}</span>
          <span className="rd-eq" /><span className="rd-value rd-dim">{childArgs.length}</span>
        </div>,
      )
      if (open) for (const [k, f] of childArgs) fieldLines(fields, k, f, `${n.id}|child.${k}`, value(f, `t:${n.id}|child.${k}`))
    }
    row(`c${n.id}`, a, (
      <div className={cls(n, 'rd-card')} data-id={n.id} onClick={(e) => p.onSelect(n, e)}>
        <div className="rd-card-head">
          {opChip(it.op)}
          {it.pe !== null && it.pe !== undefined && <span className="src-pe">{perTrip(it.pe)}</span>}
          {badges(n)}
          {taskCount(n)}
          {it.program && <button className="link src-program" onClick={(e) => { e.stopPropagation(); p.goProgram(it.program as string) }}>→ {it.program}</button>}
          {it.child !== undefined && it.child !== null && <span className="src-pe">on {perTrip(it.child)}</span>}
          <span className="spacer" />
          {sourceToggle(n, false)}
        </div>
        {groupRows(n)}
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
        { 'data-id': n.id, onClick: (e: React.MouseEvent) => p.onSelect(n, e) } as never)
      for (let l = a; l <= b; l++) codeLine(l)
      return
    }
    levels = n.levels
    current = n
    const k = it.key
    const fence = k && firstValue(k.value) === 'fence'
    const table = k && isPerTrip(k.value) && isOpen(`t:${n.id}|key`, false)
    row(`w${n.id}`, a, (
      <div className={cls(n, 'rd-wait-row')} data-id={n.id} onClick={(e) => p.onSelect(n, e)}>
        <span className="rd-wait">wait</span>
        {k && (fence ? <span className="src-fence">fence</span> : value(k, `t:${n.id}|key`))}
        {k && !fence && firstStatic(k)}
        {badges(n)}
        {taskCount(n)}
        <span className="spacer" />
        {sourceToggle(n, false)}
        {table && <div className="rd-field-table">{tableOf(k, true)}</div>}
        {groupRows(n)}
      </div>
    ), '', indent)
  }

  /** Call statements of a helper or an out-of-line closure (version 2): their lines as code,
   * the first with one marker per call item: what it calls (a link to it) and the tasks that
   * came through it (a click puts them into the focus). */
  const callRow = (group: Node[]) => {
    const [a] = group[0].item.lines
    const end = Math.max(...group.map((g) => g.item.lines[1]))
    const markers = group.map((c) => <CallMarker key={c.id} call={c} links={p.links} onSelect={p.onSelect} focus={p.focus} />)
    for (let l = a; l <= end; l++) codeLine(l, undefined, undefined, l === a ? markers : undefined)
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
      if (group.every((g) => g.item.kind === 'call')) callRow(group)
      else group.forEach(item)
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
      const calls = it.call_lines?.length
        ? <button className={isOpen(`k:${n.id}`, false) ? 'badge muted rd-calls open' : 'badge muted rd-calls'}
          onClick={(e) => { e.stopPropagation(); toggle(`k:${n.id}`, false) }}>calls {it.calls ?? '?'} ▾</button>
        : <span className="badge muted">calls {it.calls ?? '?'}</span>
      return <span className="rd-facts">{calls}{seen !== null && <span className="badge muted">seen {seen}</span>}</span>
    }
    return null
  }

  /** A closure's calls by calling line, in source order: the line (a link), what it is (the
   * summary of the region around it, else its source text), and its calls ("27 calls: 1, 5,
   * 9, … 105"; a click on the count lists them all). */
  const callList = (n: Node) => {
    const byLine = new Map<number | null, number[]>()
    ;(n.item.call_lines ?? []).forEach((l, i) => byLine.set(l, [...(byLine.get(l) ?? []), i]))
    const lines = [...byLine.keys()].sort((x, y) => (x ?? Infinity) - (y ?? Infinity))
    // the innermost region with a summary around a line (a call's first line, "run_gemm(GemmArgs {", says little)
    const regionAt = (l: number): string | null => {
      let best: Node | null = null
      const walk = (x: Node) => {
        const [a, b] = x.item.lines
        if (x.item.file !== file || l < a || l > b) return
        if (x.item.kind === 'region' && x.item.summary) best = x
        x.children.forEach(walk)
      }
      p.roots.forEach(walk)
      return (best as Node | null)?.item.summary ?? null
    }
    const source = (l: number) => regionAt(l) ?? (text(l) ?? []).map((t) => t.text).join('').trim()
    row(`k${n.id}`, null, (
      <div className="rd-call-list">
        {lines.map((l) => {
          const calls = byLine.get(l) ?? []
          const key = `kx:${n.id}:${l}`
          const all = isOpen(key, false)
          return (
            <div key={String(l)} className="rd-call-row">
              {l === null ? <span className="src-unknown">line ?</span>
                : <button className="link rd-call-line" onClick={(e) => { e.stopPropagation(); p.goLine(l) }}>line {l}</button>}
              <span className="rd-call-src">{l === null ? '' : source(l)}</span>
              <button className="link rd-call-count" onClick={(e) => { e.stopPropagation(); toggle(key, false) }}>
                {callsLabel(calls)}: {all ? calls.join(', ') : callIndices(calls)}
              </button>
            </div>
          )
        })}
      </div>
    ), '', indentOf(n.item.lines[0]) + 2)
  }

  const container = (n: Node) => {
    const [a, b] = n.item.lines
    // the header line stands for a loop or closure (a marker of a calling line selects it)
    codeLine(a, facts(n), n.item.kind === 'closure' || n.item.kind === 'loop' ? n : undefined)
    if (n.item.kind === 'closure' && n.item.call_lines?.length && isOpen(`k:${n.id}`, false)) callList(n)
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
