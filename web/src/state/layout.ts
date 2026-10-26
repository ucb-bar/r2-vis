// The workspaces: each one a tree of areas. An inner node splits its rectangle in two (side
// by side or one above the other, at a ratio); a leaf is an area that shows one view. Kept
// per browser in localStorage (not per trace), with a version in the key.

export type ViewType = 'blocks' | 'timeline' | 'instant' | 'source'

export const VIEWS: { id: ViewType; label: string }[] = [
  { id: 'blocks', label: 'Block diagram' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'instant', label: 'Instant' },
  { id: 'source', label: 'Source' },
]

export interface AreaLeaf {
  kind: 'area'
  id: string
  view: ViewType
  /** a timeline: the paths of the nodes it shows; null or absent: all nodes */
  nodes?: string[] | null
  /** view-local state that persists (sidebar width and sections), by key */
  ui?: Record<string, unknown>
}

/** 'row': a left, b right; 'column': a above, b below. */
export type SplitDir = 'row' | 'column'

export interface SplitNode {
  kind: 'split'
  dir: SplitDir
  /** the share of a, in (0, 1) */
  ratio: number
  a: LayoutNode
  b: LayoutNode
}

export type LayoutNode = AreaLeaf | SplitNode

export interface WorkspaceDef {
  id: string
  name: string
  root: LayoutNode
  /** the area shown alone (maximized), if any */
  maximized?: string | null
  /** the default workspace this one was made as (reveal finds the default Timeline) */
  base?: string
}

export interface Layout {
  version: 1
  active: string
  workspaces: WorkspaceDef[]
}

export const LAYOUT_KEY = 'r2vis.layout.v1'

let counter = 0

/** A new id, unique in this page and unlikely to repeat a stored one. */
export function newId(prefix: string): string {
  counter += 1
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`
}

const area = (view: ViewType): AreaLeaf => ({ kind: 'area', id: newId('a'), view })

/** The default workspaces: one per view, then Timeline + Instant and Source + Timeline. */
export function defaultLayout(): Layout {
  const one = (base: ViewType, name: string): WorkspaceDef => ({ id: newId('w'), name, base, root: area(base) })
  const workspaces: WorkspaceDef[] = [
    one('blocks', 'Block diagram'),
    one('timeline', 'Timeline'),
    one('instant', 'Instant'),
    one('source', 'Source'),
    { id: newId('w'), name: 'Timeline + Instant', base: 'timeline-instant',
      root: { kind: 'split', dir: 'column', ratio: 0.65, a: area('timeline'), b: area('instant') } },
    { id: newId('w'), name: 'Source + Timeline', base: 'source-timeline',
      root: { kind: 'split', dir: 'row', ratio: 0.5, a: area('source'), b: area('timeline') } },
  ]
  return { version: 1, active: workspaces[0].id, workspaces }
}

// ---- tree --------------------------------------------------------------------------------

/** The areas of a tree, in order (a before b). */
export function leaves(node: LayoutNode): AreaLeaf[] {
  return node.kind === 'area' ? [node] : [...leaves(node.a), ...leaves(node.b)]
}

/** The path of a node: 'a' and 'b' steps from the root ('' is the root). */
export function pathOf(node: LayoutNode, id: string, path = ''): string | null {
  if (node.kind === 'area') return node.id === id ? path : null
  return pathOf(node.a, id, `${path}a`) ?? pathOf(node.b, id, `${path}b`)
}

export function nodeAt(node: LayoutNode, path: string): LayoutNode {
  let n = node
  for (const step of path) {
    if (n.kind !== 'split') throw new Error(`no node at ${path}`)
    n = step === 'a' ? n.a : n.b
  }
  return n
}

/** The tree with the node at `path` replaced. */
export function replaceAt(node: LayoutNode, path: string, by: LayoutNode): LayoutNode {
  if (!path) return by
  if (node.kind !== 'split') throw new Error(`no node at ${path}`)
  return path[0] === 'a'
    ? { ...node, a: replaceAt(node.a, path.slice(1), by) }
    : { ...node, b: replaceAt(node.b, path.slice(1), by) }
}

/** An area split in two at `ratio` (the share of the left or upper part): `added` goes
 * second (right or below), or first when `addedFirst`. */
export function splitArea(root: LayoutNode, id: string, dir: SplitDir, added: AreaLeaf, ratio = 0.5, addedFirst = false): LayoutNode {
  const path = pathOf(root, id)
  if (path === null) return root
  const area = nodeAt(root, path)
  return replaceAt(root, path, { kind: 'split', dir, ratio, a: addedFirst ? added : area, b: addedFirst ? area : added })
}

/** The neighbor of an area: the other side of its split, and where it is. */
export function neighborOf(root: LayoutNode, id: string): { node: LayoutNode; side: 'left' | 'right' | 'above' | 'below' } | null {
  const path = pathOf(root, id)
  if (!path) return null
  const parent = nodeAt(root, path.slice(0, -1)) as SplitNode
  const first = path.endsWith('a')
  const side = parent.dir === 'row' ? (first ? 'right' : 'left') : (first ? 'below' : 'above')
  return { node: first ? parent.b : parent.a, side }
}

/** The area closed: the other side of its split takes its space. */
export function closeArea(root: LayoutNode, id: string): LayoutNode {
  const path = pathOf(root, id)
  if (!path) return root
  const parent = nodeAt(root, path.slice(0, -1)) as SplitNode
  return replaceAt(root, path.slice(0, -1), path.endsWith('a') ? parent.b : parent.a)
}

/** The area merged with its neighbor (an area, not a split): the area takes both spaces. */
export function mergeArea(root: LayoutNode, id: string): LayoutNode {
  const path = pathOf(root, id)
  const nb = neighborOf(root, id)
  if (!path || !nb || nb.node.kind !== 'area') return root
  return replaceAt(root, path.slice(0, -1), nodeAt(root, path))
}

export function mapLeaf(root: LayoutNode, id: string, f: (leaf: AreaLeaf) => AreaLeaf): LayoutNode {
  const path = pathOf(root, id)
  return path === null ? root : replaceAt(root, path, f(nodeAt(root, path) as AreaLeaf))
}

export function setRatio(root: LayoutNode, path: string, ratio: number): LayoutNode {
  const n = nodeAt(root, path)
  return n.kind === 'split' ? replaceAt(root, path, { ...n, ratio }) : root
}

/** A copy of a tree with new area ids (a new workspace). */
export function copyTree(node: LayoutNode): LayoutNode {
  if (node.kind === 'split') return { ...node, a: copyTree(node.a), b: copyTree(node.b) }
  return { ...node, id: newId('a'), nodes: node.nodes ? [...node.nodes] : node.nodes,
    ui: node.ui ? structuredClone(node.ui) : undefined }
}

// ---- geometry ----------------------------------------------------------------------------

/** A rectangle in shares of the workspace (0..1). */
export interface Rect { x: number; y: number; w: number; h: number }

export interface Placed {
  areas: { leaf: AreaLeaf; rect: Rect }[]
  splits: { path: string; dir: SplitDir; ratio: number; rect: Rect }[]
}

export function place(root: LayoutNode): Placed {
  const out: Placed = { areas: [], splits: [] }
  const walk = (n: LayoutNode, r: Rect, path: string) => {
    if (n.kind === 'area') { out.areas.push({ leaf: n, rect: r }); return }
    out.splits.push({ path, dir: n.dir, ratio: n.ratio, rect: r })
    if (n.dir === 'row') {
      walk(n.a, { ...r, w: r.w * n.ratio }, `${path}a`)
      walk(n.b, { ...r, x: r.x + r.w * n.ratio, w: r.w * (1 - n.ratio) }, `${path}b`)
    } else {
      walk(n.a, { ...r, h: r.h * n.ratio }, `${path}a`)
      walk(n.b, { ...r, y: r.y + r.h * n.ratio, h: r.h * (1 - n.ratio) }, `${path}b`)
    }
  }
  walk(root, { x: 0, y: 0, w: 1, h: 1 }, '')
  return out
}

/** The smallest size of an area (CSS px, with its header). */
export const MIN_AREA = { w: 220, h: 120 }

/** The smallest size of a subtree (CSS px). */
export function minSize(n: LayoutNode): { w: number; h: number } {
  if (n.kind === 'area') return { ...MIN_AREA }
  const a = minSize(n.a)
  const b = minSize(n.b)
  return n.dir === 'row' ? { w: a.w + b.w, h: Math.max(a.h, b.h) } : { w: Math.max(a.w, b.w), h: a.h + b.h }
}

// ---- persistence -------------------------------------------------------------------------

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const VIEW_IDS = new Set<string>(VIEWS.map((v) => v.id))

function validNode(v: unknown, ids: Set<string>): v is LayoutNode {
  if (!isObject(v)) return false
  if (v.kind === 'area') {
    if (typeof v.id !== 'string' || !v.id || ids.has(v.id) || !VIEW_IDS.has(v.view as string)) return false
    if (v.nodes !== undefined && v.nodes !== null && !(Array.isArray(v.nodes) && v.nodes.every((p) => typeof p === 'string'))) return false
    if (v.ui !== undefined && !isObject(v.ui)) return false
    ids.add(v.id)
    return true
  }
  return v.kind === 'split' && (v.dir === 'row' || v.dir === 'column') && typeof v.ratio === 'number'
    && v.ratio > 0 && v.ratio < 1 && validNode(v.a, ids) && validNode(v.b, ids)
}

/** A stored layout if it is valid, else null. */
export function validLayout(v: unknown): Layout | null {
  if (!isObject(v) || v.version !== 1 || !Array.isArray(v.workspaces) || !v.workspaces.length) return null
  const ids = new Set<string>()
  const wsIds = new Set<string>()
  for (const w of v.workspaces as unknown[]) {
    if (!isObject(w) || typeof w.id !== 'string' || !w.id || wsIds.has(w.id) || typeof w.name !== 'string') return null
    if (w.maximized !== undefined && w.maximized !== null && typeof w.maximized !== 'string') return null
    if (w.base !== undefined && typeof w.base !== 'string') return null
    if (!validNode(w.root, ids)) return null
    wsIds.add(w.id)
  }
  const layout = v as unknown as Layout
  return wsIds.has(layout.active) ? layout : { ...layout, active: layout.workspaces[0].id }
}

/** The stored layout, or the defaults if there is none or it is not valid. */
export function loadLayout(): Layout {
  try {
    const text = localStorage.getItem(LAYOUT_KEY)
    if (text) {
      const l = validLayout(JSON.parse(text))
      if (l) return l
    }
  } catch {
    // storage unavailable or not JSON: the defaults
  }
  return defaultLayout()
}

export function saveLayout(l: Layout): void {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(l))
  } catch {
    // storage unavailable: the layout is not kept
  }
}
