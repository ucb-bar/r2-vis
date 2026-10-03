// The rows of the timeline. The checked blocks form a forest: each checked node sits under
// its nearest checked ancestor. Each shown node is a collapsible group with its own rows,
// then its child groups. Own rows: task lanes, plain resource rows (PE arrays, Neutrino
// scalar and completion ports, memory ports), and fabric nodes: one per bus (its ports as
// child rows) and one per bridge (its two directions as child rows), collapsed by default.
// The user can reorder rows inside their container (a node, or a fabric node), hide them
// and resize them.
import { fabricOf } from '../data/fabrics'
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

/** A bus or a bridge: the resources of its ports or directions. */
export interface Fabric {
  id: number
  key: string
  path: string             // bus path, or bridge path
  kind: 'bus' | 'bridge'
  members: number[]        // resource ids, in row order
  members_rows: Row[]      // their rows (shown when the fabric node is open)
}

export const ROW_HEIGHT = { group: 22, lane: 18, resource: 30, fabric: 30, note: 20 } as const
/** Height of one sub-row of a lane at the default lane height. */
export const SUBROW_HEIGHT = 12
export const MIN_ROW_HEIGHT = 12
export const MAX_ROW_HEIGHT = 240

const ROLE_ORDER: Record<string, number> = {
  pe: 0, scalar: 1, complete: 2, mem_port: 3, bridge: 4, bus: 5, port: 6, other: 7,
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
    for (const r of res) {
      const typeKept = r.class === 'control' ? this.rec.messages : this.rec.charges
      const charged = (r.busy_cycles as number) > 0 || (r.amount as number) > 0
      if (!charged && typeKept) continue  // no charge in the whole run: hidden
      const name = String(r.name)
      const entity = fabricOf(t.dims, r)
      const row: Row = { kind: 'resource', key: `r:${name}`, depth: 0, height: ROW_HEIGHT.resource,
        label: name.startsWith(`${path}.`) ? name.slice(path.length + 1) : name, node: id,
        id: r.id as number, notRecorded: !typeKept, parent: path }
      if (!entity) {
        out.push(row)
        continue
      }
      let f = fabricByPath.get(entity.path)
      if (!f) {
        f = { id: this.fabrics.length, key: `f:${entity.path}`, path: entity.path, kind: entity.kind,
          members: [], members_rows: [] }
        this.fabrics.push(f)
        fabricByPath.set(entity.path, f)
        out.push({ kind: 'fabric', key: f.key, depth: 0, height: ROW_HEIGHT.fabric,
          label: entity.path.startsWith(`${path}.`) ? entity.path.slice(path.length + 1) : entity.path,
          node: id, id: f.id, notRecorded: true, parent: path })
      }
      f.members.push(r.id as number)
      f.members_rows.push({ ...row, parent: f.key,
        label: name.startsWith(`${entity.path}.`) ? name.slice(entity.path.length + 1) : row.label })
    }
    // A fabric node is "not recorded" only if all its members are.
    for (const row of out) {
      if (row.kind === 'fabric') row.notRecorded = this.fabrics[row.id].members_rows.every((m) => m.notRecorded)
    }
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
      for (const r of orderRows(this.own[id], o.order.get(path))) {
        if (o.hidden.has(r.key)) continue
        push(r, depth + 1)
        if (r.kind === 'fabric' && o.fabricOpen.has(r.key)) {
          const f = this.fabrics[r.id]
          for (const m of orderRows(f.members_rows, o.order.get(f.key))) {
            if (!o.hidden.has(m.key)) push(m, depth + 2)
          }
        }
      }
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
