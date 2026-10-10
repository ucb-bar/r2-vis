// The rows of the timeline. The checked blocks form a forest: each checked node sits under
// its nearest checked ancestor. Each shown node is a collapsible group with its own rows,
// then its child groups. Own rows: task lanes, plain resource rows (PE arrays, Neutrino
// scalar and completion ports, memory ports), and fabric nodes: one per bus (its ports as
// child rows) and one per link (its two directions as child rows), collapsed by default.
// The user can reorder rows inside their container (a node, or a fabric node), hide them
// and resize them.
import { fabricChain, type FabricEntity } from '../data/fabrics'
import type { Trace } from '../data/trace'

export type RowKind = 'group' | 'lane' | 'resource' | 'fabric' | 'note'

export interface Row {
  kind: RowKind
  key: string
  depth: number
  height: number
  label: string
  node: number
  /** lane id (lane rows), resource id (resource rows), fabric id (fabric rows), node id */
  id: number
  /** the record type of this row is not in the dump (filters or absent files) */
  notRecorded: boolean
  /** container of the row: the node path (own rows) or the fabric node's key (its members) */
  parent: string
}

/** A bus or a link: the resources of its ports or directions. */
export interface Fabric {
  id: number
  key: string
  path: string             // bus, link, memory, bank or channel path
  kind: FabricEntity['kind']
  members: number[]        // resource ids below it (all levels), in row order
  members_rows: Row[]      // the rows one level below (shown when the fabric node is open)
}

const LINK_DIR_MARK: Record<string, string> = { up: '↑', down: '↓' }

export const ROW_HEIGHT = { group: 22, lane: 18, resource: 30, fabric: 30, note: 20 } as const
/** Height of one sub-row of a lane at the default lane height. */
export const SUBROW_HEIGHT = 12
export const MIN_ROW_HEIGHT = 12
export const MAX_ROW_HEIGHT = 240

const ROLE_ORDER: Record<string, number> = {
  pe: 0, scalar: 1, complete: 2, mem_port: 3, link: 4, bus: 5, port: 6, other: 7,
}

export interface RowModel {
  rows: Row[]
  top: Float64Array    // y of each row (content coordinates)
  height: number       // total content height
  rowOfLane: Int32Array      // lane id -> row index, -1 if not shown
}

export interface Recorded {
  tasks: boolean
  charges: boolean     // task, load, store and program work charges
  messages: boolean    // protocol message charges
  inTree: boolean[]    // per node: inside the listed subtrees
  window: [number, number] | null
}

export interface RowOptions {
  collapsed: ReadonlySet<number>
  /** fabric node keys that are open (fabric nodes are collapsed by default) */
  fabricOpen: ReadonlySet<string>
  hidden: ReadonlySet<string>
  heights: ReadonlyMap<string, number>
  /** container (node path or fabric key) -> row keys in order */
  order: ReadonlyMap<string, string[]>
  checked: ReadonlySet<number>
}

/** What the dump recorded (manifest.source.filters and absent files). */
export function recorded(trace: Trace): Recorded {
  const f = trace.manifest.source.filters
  const absent = new Set(trace.manifest.source.absent_records ?? [])
  const types = f?.types ?? null
  const records = f?.records ?? null
  const kept = (t: string, file: string) =>
    (types ? types.includes(t) : true) && (records ? records.includes(file) : true) && !absent.has(file)
  const subtrees = f?.nodes ?? null
  const inTree = trace.dims.nodes.map((n) => !subtrees ||
    subtrees.some((p) => n.path === p || String(n.path).startsWith(`${p}.`)))
  return {
    tasks: kept('tasks', 'tasks'),
    charges: kept('charges', 'charges'),
    messages: kept('messages', 'charges'),
    inTree,
    window: f?.window ?? null,
  }
}

/** The static parts of the row model: tree, own rows of every node, fabric nodes. */
export class RowSource {
  readonly trace: Trace
  readonly rec: Recorded
  readonly parent: (number | null)[]
  readonly children: Map<number, number[]>
  readonly recordedBelow: boolean[]
  readonly fabrics: Fabric[] = []
  private readonly own: Row[][]    // per node: its own rows in default order (heights default)

  constructor(trace: Trace, rec: Recorded) {
    this.trace = trace
    this.rec = rec
    const nodes = trace.dims.nodes
    this.parent = nodes.map((n) => n.parent as number | null)
    this.children = new Map()
    for (const n of nodes) {
      const p = n.parent as number | null
      if (p !== null) this.children.set(p, [...(this.children.get(p) ?? []), n.id as number])
    }
    this.recordedBelow = subtreeRecorded(nodes.length, this.children, rec.inTree)
    const laneTasks = new Int32Array(trace.dims.lanes.length)
    const laneCol = trace.facts.tasks.cols.lane as Int32Array
    for (let i = 0; i < laneCol.length; i++) if (laneCol[i] >= 0) laneTasks[laneCol[i]]++
    this.own = nodes.map((n) => this.ownRows(n.id as number, laneTasks))
  }

  /** A node's own rows, in default order. */
  ownRowsOf(node: number): Row[] {
    return this.own[node]
  }

  /** Rows inside a container: a node's own rows, or a fabric node's member rows. */
  rowsIn(container: string): Row[] {
    if (container.startsWith('f:')) return this.fabrics.find((f) => f.key === container)?.members_rows ?? []
    const id = this.trace.dims.nodes.findIndex((n) => n.path === container)
    return id < 0 ? [] : this.own[id]
  }

  private ownRows(id: number, laneTasks: Int32Array): Row[] {
    const t = this.trace
    const path = String(t.dims.nodes[id].path)
    const inTree = this.rec.inTree[id]
    const out: Row[] = []
    if (!inTree) {
      out.push({ kind: 'note', key: `n:${path}`, depth: 0, height: ROW_HEIGHT.note,
        label: 'lanes and resources of this node', node: id, id, notRecorded: true, parent: path })
      return out
    }
    for (const l of t.dims.lanes) {
      if (l.node !== id) continue
      const notRecorded = !this.rec.tasks
      // A lane with no task in the whole run is hidden, unless tasks are not recorded.
      if (!notRecorded && laneTasks[l.id as number] === 0) continue
      const lpath = String(l.path)
      const subrows = notRecorded ? 1 : t.lanes.depth[l.id as number]
      const name = l.pe === null ? 'neutrino' : lpath.slice(path.length + 1)
      out.push({ kind: 'lane', key: `l:${lpath}`, depth: 0,
        height: ROW_HEIGHT.lane + (subrows - 1) * SUBROW_HEIGHT,
        label: subrows > 1 ? `${name} ×${subrows}` : name, node: id, id: l.id as number, notRecorded,
        parent: path })
    }
    const res = t.dims.resources.filter((r) => r.node === id).sort((a, b) =>
      (ROLE_ORDER[String(a.role)] ?? 9) - (ROLE_ORDER[String(b.role)] ?? 9) || (a.id as number) - (b.id as number))
    const fabricByPath = new Map<string, Fabric>()
    const fabricRows: Row[] = []   // this node's fabric rows, outer before inner
    for (const r of res) {
      const typeKept = r.class === 'control' ? this.rec.messages : this.rec.charges
      const charged = (r.busy_cycles as number) > 0 || (r.amount as number) > 0
      if (!charged && typeKept) continue  // no charge in the whole run: hidden
      const name = String(r.name)
      const chain = fabricChain(t.dims, r)
      const row: Row = { kind: 'resource', key: `r:${name}`, depth: 0, height: ROW_HEIGHT.resource,
        label: rel(name, path), node: id, id: r.id as number, notRecorded: !typeKept, parent: path }
      if (!chain.length) {
        out.push(row)
        continue
      }
      // The fabric nodes of the chain, outermost first: each in its parent's rows.
      const mark = LINK_DIR_MARK[String(r.link_dir)] ?? String(r.link_dir)
      let rows = out
      let parentKey = path
      let parentPath = path
      let top = ''   // the link's label, for its direction nodes
      for (const e of chain) {
        let f = fabricByPath.get(e.path)
        if (!f) {
          f = { id: this.fabrics.length, key: `f:${e.path}`, path: e.path, kind: e.kind, members: [], members_rows: [] }
          this.fabrics.push(f)
          fabricByPath.set(e.path, f)
          const label = e.kind === 'channel' && top ? `${top} ${mark}` : rel(e.path, parentPath)
          const frow: Row = { kind: 'fabric', key: f.key, depth: 0, height: ROW_HEIGHT.fabric, label, node: id,
            id: f.id, notRecorded: true, parent: parentKey }
          rows.push(frow)
          fabricRows.push(frow)
        }
        if (e.kind === 'link') top = rel(e.path, parentPath)
        f.members.push(r.id as number)
        rows = f.members_rows
        parentKey = f.key
        parentPath = e.path
      }
      // A leaf: its name below its innermost node (a channel's read and write channels; a
      // link direction: the link's name and its hierarchy direction, else ab / ba).
      const inner = chain[chain.length - 1]
      const label = inner.kind === 'channel' ? (r.write ? 'write' : 'read')
        : inner.kind === 'link' ? `${top} ${mark}` : rel(name, inner.path)
      rows.push({ ...row, parent: parentKey, label })
    }
    // A channel or bank node with one row left (its write channel or write port carried
    // nothing and is hidden) is that row, under the node's name.
    const lists = [out, ...fabricRows.map((r) => this.fabrics[r.id].members_rows)]
    for (const row of fabricRows) {
      const f = this.fabrics[row.id]
      if ((f.kind !== 'channel' && f.kind !== 'bank') || f.members_rows.length !== 1) continue
      const only = f.members_rows[0]
      const label = f.kind === 'bank' ? `${row.label}.${only.label}` : only.label === 'write' ? `${row.label} (write)` : row.label
      for (const list of lists) {
        const i = list.indexOf(row)
        if (i >= 0) list[i] = { ...only, label, parent: row.parent }
      }
    }
    // A fabric node is "not recorded" only if all its members are (innermost first).
    for (const row of [...fabricRows].reverse()) row.notRecorded = this.fabrics[row.id].members_rows.every((m) => m.notRecorded)
    return out
  }

  /** Nearest checked ancestor of a node, or null. */
  checkedAncestor(node: number, checked: ReadonlySet<number>): number | null {
    let p = this.parent[node]
    while (p !== null && !checked.has(p)) p = this.parent[p]
    return p
  }

  build(o: RowOptions): RowModel {
    const nodes = this.trace.dims.nodes
    // The forest of checked nodes, in node order.
    const kids = new Map<number | null, number[]>()
    for (const n of nodes) {
      const id = n.id as number
      if (!o.checked.has(id)) continue
      const a = this.checkedAncestor(id, o.checked)
      kids.set(a, [...(kids.get(a) ?? []), id])
    }
    const rows: Row[] = []
    const push = (r: Row, depth: number) => rows.push({ ...r, depth, height: o.heights.get(r.key) ?? r.height })
    const visit = (id: number, depth: number) => {
      const path = String(nodes[id].path)
      rows.push({ kind: 'group', key: `g:${path}`, depth, height: ROW_HEIGHT.group, label: path,
        node: id, id, notRecorded: !this.rec.inTree[id] && !this.recordedBelow[id], parent: '' })
      if (o.collapsed.has(id)) return
      // A row, and the rows of an open fabric node below it (nested fabric nodes too).
      const place = (r: Row, d: number) => {
        if (o.hidden.has(r.key)) return
        push(r, d)
        if (r.kind === 'fabric' && o.fabricOpen.has(r.key)) {
          const f = this.fabrics[r.id]
          for (const m of orderRows(f.members_rows, o.order.get(f.key))) place(m, d + 1)
        }
      }
      for (const r of orderRows(this.own[id], o.order.get(path))) place(r, depth + 1)
      for (const c of kids.get(id) ?? []) visit(c, depth + 1)
    }
    for (const root of kids.get(null) ?? []) visit(root, 0)
    const top = new Float64Array(rows.length)
    let y = 0
    rows.forEach((r, i) => { top[i] = y; y += r.height })
    const rowOfLane = new Int32Array(this.trace.dims.lanes.length).fill(-1)
    rows.forEach((r, i) => { if (r.kind === 'lane') rowOfLane[r.id] = i })
    return { rows, top, height: y, rowOfLane }
  }

  /** Groups collapsed at open: the nodes with nothing recorded in their subtree. */
  initialCollapsed(): Set<number> {
    const out = new Set<number>()
    this.trace.dims.nodes.forEach((n) => {
      const id = n.id as number
      if (!this.rec.inTree[id] && !this.recordedBelow[id]) out.add(id)
    })
    return out
  }
}

/** Rows in the user's order (keys not in the order keep their default place at the end). */
function orderRows(rows: Row[], order: string[] | undefined): Row[] {
  if (!order || order.length === 0) return rows
  const rank = new Map(order.map((k, i) => [k, i]))
  const place = new Map(rows.map((r, i) => [r.key, rank.get(r.key) ?? 1e9 + i]))
  return [...rows].sort((a, b) => (place.get(a.key) as number) - (place.get(b.key) as number))
}

/** Per node: a descendant (not the node itself) is inside the recorded subtrees. */
function subtreeRecorded(n: number, children: Map<number, number[]>, inTree: boolean[]): boolean[] {
  const out = new Array<boolean>(n).fill(false)
  const visit = (id: number): boolean => {
    let any = false
    for (const c of children.get(id) ?? []) if (visit(c) || inTree[c]) any = true
    out[id] = any
    return any
  }
  const isChild = new Set([...children.values()].flat())
  for (let id = 0; id < n; id++) if (!isChild.has(id)) visit(id)
  return out
}

/** Index of the row at content y (binary search), or -1. */
export function rowAt(model: RowModel, y: number): number {
  let lo = 0
  let hi = model.rows.length - 1
  if (hi < 0 || y < 0 || y >= model.height) return -1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (model.top[mid] <= y) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** A path or name below a parent path, without the parent's prefix. */
function rel(name: string, parent: string): string {
  return name.startsWith(`${parent}.`) ? name.slice(parent.length + 1) : name
}
