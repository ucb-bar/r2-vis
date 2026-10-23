// The Source view (r2-toolchain docs/source-map.md, version 1): a Neutrino program of a
// loaded source map, in two modes. Readable (source/Readable.tsx): the program's functions
// in source order, with cards for invokes and waits. Source: the plain file. It holds the
// programs of all loaded maps; each area keeps its program, file, mode, folds and scroll.
// With a trace open, cards show their tasks and producers, and a task's "Show source"
// selects its item (source/links.ts). It fills the container it gets.
import { useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { Trace } from '../data/trace'
import type { Store } from '../state/store'
import type { ViewStore } from '../state/viewstore'
import { AreaContext, useAreaState } from '../ui/area'
import { Tooltip, tipPlace, type TipContent } from '../ui/Tooltip'
import { linkFor, programIndex, type LoadedMap, type MapProgram, type Producer } from './links'
import { tokenSpans } from './parts'
import { opColor, Readable, regionKey, type CardLinks } from './Readable'
import { tokenizeRust, type Token } from './rust'
import { DepIndex, innermostAt, type Node, type SourceMap } from './srcmap'

interface Props {
  maps: LoadedMap[]
  error?: string | null
  onOpen: (file: File) => void
  /** the open trace: task counts per item, the status of each program against the run */
  trace?: Trace
  store?: ViewStore
  /** tasks whose item to show (its pc), routed to this area */
  request?: Store<number | null>
}

type Mode = 'readable' | 'source'

/** The program shown: its map's file name and its name (they survive a reload). */
interface Shown { map: string; program: string }

/** Whether an item holds an invoke or a wait (a region with one is open by default). */
const active = (n: Node): boolean => n.item.kind === 'invoke' || n.item.kind === 'wait' || n.children.some(active)

export function SourceView({ maps, error, onOpen, trace, store, request }: Props) {
  const area = useContext(AreaContext)
  const [mode, setMode] = useAreaState<Mode>('source.mode', () => 'readable')
  const [shown, setShown] = useAreaState<Shown | null>('source.program', () => null)
  const [files, setFiles] = useAreaState<Record<string, number>>('source.file', () => ({}))
  const [toggledList, setToggledList] = useAreaState<string[]>('source.open', () => [])
  const [sel, setSel] = useState<Map<string, string>>(new Map())
  const [highlight, setHighlight] = useState<{ key: string; id: string } | null>(null)
  const [tip, setTip] = useState<{ x: number; y: number; content: TipContent } | null>(null)
  const [pending, setPending] = useState<number | null>(null)
  const [missing, setMissing] = useState<string | null>(null)
  const host = useRef<HTMLDivElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const me = useRef({})
  const toggled = useMemo(() => new Set(toggledList), [toggledList])

  // The programs of all loaded maps, in map order; the one shown.
  const entries = useMemo(() => maps.flatMap((m, mi) => m.map.programs.map((p, k) => ({ mi, pi: k, m, p }))), [maps])
  const at = Math.max(0, entries.findIndex((e) => e.m.name === shown?.map && e.p.program === shown?.program))
  const entry = entries[at] ?? null
  const map = entry?.m.map ?? null
  const program = entry?.p ?? null
  const pkey = entry ? `${entry.m.name}/${entry.p.program}` : ''
  const index = useMemo(() => (program ? programIndex(program) : null), [program])
  const deps = useMemo(() => (index ? new DepIndex(index.all, map?.granule) : null), [index, map])
  const tokens = useMemo(() => (map ? tokensOf(map) : []), [map])
  const file = entry ? files[pkey] ?? program?.items[0]?.file ?? 0 : 0
  const selectedId = sel.get(pkey) ?? null
  const selected = selectedId ? index?.byId.get(selectedId) ?? null : null
  const link = useMemo(() => (trace ? linkFor(trace, maps) : null), [trace, maps])
  const mp: MapProgram | null = entry ? { mi: entry.mi, pi: entry.pi } : null
  const status = link && mp ? link.statusOf(mp) : null
  const linked = status === 'match' || status === 'unverified'
  const cardLinks = useMemo<CardLinks | null>(() => (link && mp && linked
    ? { tasks: (n) => link.tasksOf(mp, n), producers: (n, k) => link.producersOf(mp, n, k) } : null), [link, mp?.mi, mp?.pi, linked])

  const hover = (e: React.MouseEvent, content: TipContent | null) => {
    const r = host.current?.getBoundingClientRect()
    setTip(content && r ? { x: e.clientX - r.left, y: e.clientY - r.top, content } : null)
  }
  const clear = () => setTip(null)

  // ---- state per program ---------------------------------------------------------------------
  const isOpen = (key: string, dflt: boolean) => dflt !== toggled.has(`${pkey}#${key}`)
  const toggle = (key: string) => {
    const k = `${pkey}#${key}`
    setToggledList((l) => (l.includes(k) ? l.filter((x) => x !== k) : [...l, k]))
  }
  const show = (k: number, node: Node | null) => {
    const e = entries[k]
    if (!e) return
    const key = `${e.m.name}/${e.p.program}`
    setShown({ map: e.m.name, program: e.p.program })
    setSel((s) => new Map(s).set(key, node?.id ?? ''))
    if (!node) return
    setFiles((f) => ({ ...f, [key]: node.item.file }))
    // The regions around the item open.
    const flip: string[] = []
    for (let a = node.parent; a; a = a.parent) {
      const k2 = `${key}#${regionKey(a)}`
      if (a.item.kind === 'region' && active(a) === toggled.has(k2)) flip.push(k2)
    }
    if (flip.length) setToggledList((l) => [...l.filter((x) => !flip.includes(x)), ...flip.filter((x) => !l.includes(x))])
    store?.sourceSelection.set({ map: e.m.name, program: e.p.program, id: node.id, from: me.current })
  }
  const select = (n: Node | null) => { if (entry) show(at, n) }
  /** A program by name: of the same map first, else of any map. */
  const goProgram = (programName: string) => {
    let k = entries.findIndex((e) => e.mi === entry?.mi && e.p.program === programName)
    if (k < 0) k = entries.findIndex((e) => e.p.program === programName)
    if (k >= 0) show(k, null)
  }
  const onProducer = (pr: Producer) => {
    if (!pr.mp) return
    show(entries.findIndex((e) => e.mi === pr.mp?.mi && e.pi === pr.mp?.pi), pr.node)
  }

  // ---- requests (Show source), the other areas' selection ---------------------------------------
  useEffect(() => {
    if (!request) return
    const take = (task: number | null) => { if (task !== null) { setPending(task); request.set(null) } }
    take(request.get())
    return request.subscribe(take)
  }, [request])
  useEffect(() => {
    if (pending === null || !link) return
    const loc = link.locate(pending)
    if (!loc) { setPending(null); return }
    if ('missing' in loc) { setMissing(loc.missing); return }
    setPending(null)
    setMissing(null)
    show(entries.findIndex((e) => e.mi === loc.mp.mi && e.pi === loc.mp.pi), loc.node)
  }, [pending, link, entries])
  useEffect(() => {
    if (!store) return
    return store.sourceSelection.subscribe((s) => {
      if (s && s.from !== me.current) setHighlight({ key: `${s.map}/${s.program}`, id: s.id })
    })
  }, [store])

  // ---- scroll: the selected item in view; the position kept per area, program and mode ---------
  useEffect(() => {
    const el = selectedId ? scroller.current?.querySelector<HTMLElement>(`[data-id="${selectedId}"]`) : null
    const box = scroller.current?.getBoundingClientRect()
    const r = el?.getBoundingClientRect()
    if (el && box && r && (r.top < box.top || r.bottom > box.bottom)) el.scrollIntoView({ block: 'center' })
  }, [selectedId, pkey, mode])
  useEffect(() => {
    const el = scroller.current
    if (!el || !area) return
    const saved = area.ui('source.scroll') as Record<string, number> | undefined
    const top = saved?.[`${pkey}|${mode}`]
    if (top !== undefined) el.scrollTop = top
    let timer = 0
    const onScroll = () => {
      clearTimeout(timer)
      timer = window.setTimeout(() => {
        const s = (area.ui('source.scroll') as Record<string, number> | undefined) ?? {}
        area.setUi('source.scroll', { ...s, [`${pkey}|${mode}`]: el.scrollTop })
      }, 300)
    }
    el.addEventListener('scroll', onScroll)
    return () => { el.removeEventListener('scroll', onScroll); clearTimeout(timer) }
  }, [area, pkey, mode, entry !== null])

  const picker = (
    <>
      <button className="button small" onClick={() => input.current?.click()}>Open source map…</button>
      <input ref={input} type="file" accept=".json,application/json" hidden
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onOpen(f); e.target.value = '' }} />
    </>
  )
  const missingNote = missing && <div className="source-missing">Open the source map of <strong>{missing}</strong></div>
  if (!map || !program || !index || !deps || !entry) {
    return (
      <div className="source-view empty" ref={host}>
        <div className="source-empty">{missingNote}{picker}{error && <div className="error">{error}</div>}</div>
      </div>
    )
  }

  const notes = program.notes ?? []
  return (
    <div className="source-view" ref={host}>
      <div className="source-head">
        <label className="tool">
          program
          <select value={at} onChange={(e) => show(Number(e.target.value), null)}>
            {entries.map((e, k) => <option key={`${e.mi}:${e.pi}`} value={k}>{e.p.program}{maps.length > 1 ? ` · ${e.m.name}` : ''}</option>)}
          </select>
        </label>
        <div className="segmented source-mode" role="tablist">
          {(['readable', 'source'] as Mode[]).map((m) => (
            <button key={m} role="tab" aria-selected={mode === m} className={mode === m ? 'seg active' : 'seg'}
              onClick={() => setMode(m)}>{m === 'readable' ? 'Readable' : 'Source'}</button>
          ))}
        </div>
        {map.files.length > 1 && (
          <select className="source-file" aria-label="file" value={file} onChange={(e) => setFiles((f) => ({ ...f, [pkey]: Number(e.target.value) }))}>
            {map.files.map((f, k) => <option key={f.path} value={k}>{f.path}</option>)}
          </select>
        )}
        <span className="badge">{program.node}</span>
        {status === 'stale' && <span className="badge warn src-status">does not match the run</span>}
        {status === 'unverified' && (
          <span className="badge muted src-status" onMouseEnter={(e) => hover(e, { title: 'unverified', sections: [{ kind: 'note', text: 'no sha256 in the map: matched by name and bytes' }] })}
            onMouseLeave={clear}>unverified</span>
        )}
        <span className="source-meta">{map.config}</span>
        <span className="source-meta">{program.image.elf}</span>
        {notes.length > 0 && (
          <span className="badge warn src-notes" onMouseEnter={(e) => hover(e, { title: 'notes', sections: notes.map((t) => ({ kind: 'note', text: t })) })}
            onMouseLeave={clear}>notes {notes.length}</span>
        )}
        <span className="spacer" />
        <span className="source-meta">{entry.m.name}</span>
        {picker}
      </div>
      {missingNote}
      {mode === 'readable' ? (
        <div className="source-readable" ref={scroller}>
          <Readable program={program} roots={index.roots} lines={tokens[file] ?? []} file={file} deps={deps}
            selected={selectedId} highlight={highlight?.key === pkey ? highlight.id : null}
            isOpen={isOpen} toggle={toggle} onSelect={select} onProducer={onProducer} links={cardLinks}
            selectTasks={(rows) => store?.tasks.set(new Set(rows))} goProgram={goProgram} hover={hover} clear={clear} />
        </div>
      ) : (
        <SourcePane scroller={scroller} tokens={tokens} index={index.all} file={file} selected={selected}
          onLine={(line) => select(innermostAt(index.all, file, line))} />
      )}
      {tip && <Tooltip tip={tip.content} style={tipPlace(tip, host.current)} />}
    </div>
  )
}

const tokenCache = new WeakMap<SourceMap, Token[][][]>()

/** The tokens of a map's files, made once per map. */
function tokensOf(map: SourceMap): Token[][][] {
  let t = tokenCache.get(map)
  if (!t) { t = map.files.map((f) => tokenizeRust(f.text)); tokenCache.set(map, t) }
  return t
}

interface PaneProps {
  scroller: React.RefObject<HTMLDivElement | null>
  tokens: Token[][][]
  index: Node[]
  file: number
  selected: Node | null
  onLine: (line: number) => void
}

/** The plain file (Source mode): line numbers, syntax colors, a mark per invoke line (by
 * op), the selected item's lines highlighted and scrolled into view. */
function SourcePane({ scroller, tokens, index, file, selected, onLine }: PaneProps) {
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
