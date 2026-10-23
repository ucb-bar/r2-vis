// The workspaces of an open trace: the layout (kept per browser), the order in which areas
// were last used, and per Timeline area its node set and its reveal requests. All areas
// share the ViewStore; the block diagram edits the node set of the target timeline.
import type { Trace } from '../data/trace'
import type { TimelineRenderer } from '../timeline/renderer'
import { BlockSelection } from './blocks'
import {
  closeArea, copyTree, defaultLayout, leaves, mapLeaf, mergeArea, newId, saveLayout, setRatio, splitArea,
  type AreaLeaf, type Layout, type LayoutNode, type SplitDir, type ViewType, type WorkspaceDef,
} from './layout'
import { Store } from './store'
import type { ViewStore } from './viewstore'

declare global {
  interface Window { __r2timeline?: TimelineRenderer; __r2workbench?: Workbench }
}

/** A Timeline area: the nodes it shows, its reveal requests, its renderer once mounted. */
export interface TimelineArea {
  blocks: BlockSelection
  reveal: Store<number | null>
  renderer: TimelineRenderer | null
  off: () => void
}

export class Workbench {
  readonly layout: Store<Layout>
  /** Bumped when the use order or a timeline's renderer changes (the Instant strip). */
  readonly changes = new Store(0)
  /** The workspaces shown at least once: their areas stay mounted. */
  readonly mounted = new Set<string>()
  private readonly trace: Trace
  private readonly store: ViewStore
  private readonly used = new Map<string, number>()
  private clock = 0
  private readonly timelines = new Map<string, TimelineArea>()
  private readonly allNodes: BlockSelection

  constructor(trace: Trace, store: ViewStore, layout: Layout) {
    this.trace = trace
    this.store = store
    this.allNodes = new BlockSelection(trace.dims.nodes.map((n) => n.id as number))
    this.layout = new Store(layout)
    this.mounted.add(layout.active)
    // The default Timeline workspace is mounted from the start (the Instant strip and the
    // block diagram show its timeline, as before the workspaces).
    const tl = this.defaultTimeline()
    if (tl) this.mounted.add(tl.ws.id)
    this.refresh()
  }

  // ---- queries -------------------------------------------------------------------------

  get active(): WorkspaceDef {
    const l = this.layout.get()
    return l.workspaces.find((w) => w.id === l.active) ?? l.workspaces[0]
  }

  find(id: string): { ws: WorkspaceDef; leaf: AreaLeaf } | null {
    for (const ws of this.layout.get().workspaces) {
      const leaf = leaves(ws.root).find((l) => l.id === id)
      if (leaf) return { ws, leaf }
    }
    return null
  }

  /** The most recently used area of a list (the first if none was used). */
  private latest(areas: AreaLeaf[]): AreaLeaf | null {
    let best: AreaLeaf | null = null
    let at = -1
    for (const a of areas) {
      const t = this.used.get(a.id) ?? -1
      if (best === null || t > at) { best = a; at = t }
    }
    return best
  }

  private timelineLeaves(ws: WorkspaceDef): AreaLeaf[] {
    return leaves(ws.root).filter((l) => l.view === 'timeline')
  }

  private defaultTimeline(): { ws: WorkspaceDef; leaf: AreaLeaf } | null {
    const all = this.layout.get().workspaces
    for (const ws of [...all.filter((w) => w.base === 'timeline'), ...all]) {
      const leaf = this.timelineLeaves(ws)[0]
      if (leaf) return { ws, leaf }
    }
    return null
  }

  /** The timeline that the block diagram, the Instant strip and window.__r2timeline use:
   * the most recently used one of the active workspace, else of any workspace, else the
   * one of the default Timeline workspace. */
  targetTimeline(): string | null {
    const here = this.latest(this.timelineLeaves(this.active))
    if (here) return here.id
    const all = this.layout.get().workspaces.flatMap((w) => this.timelineLeaves(w)).filter((l) => this.used.has(l.id))
    return this.latest(all)?.id ?? this.defaultTimeline()?.leaf.id ?? null
  }

  /** The most recently used area of a workspace (the first if none was used). */
  lastUsedIn(ws: WorkspaceDef): string | null {
    return this.latest(leaves(ws.root))?.id ?? null
  }

  /** The renderer of the target timeline, or of any mounted timeline. */
  stripRenderer(): TimelineRenderer | null {
    const id = this.targetTimeline()
    const r = id ? this.timelines.get(id)?.renderer : null
    return r ?? [...this.timelines.values()].find((t) => t.renderer)?.renderer ?? null
  }

  /** The timeline that handles the keyboard: the target timeline of the active workspace
   * when it is shown. */
  isKeyTarget(id: string): boolean {
    const ws = this.active
    if (ws.maximized && ws.maximized !== id) return false
    return this.latest(this.timelineLeaves(ws))?.id === id
  }

  /** The state of a Timeline area (made when first asked for). */
  timeline(id: string): TimelineArea {
    let t = this.timelines.get(id)
    if (t) return t
    const found = this.find(id)
    const blocks = new BlockSelection(this.nodeIds(found?.leaf.nodes ?? null))
    const off = blocks.subscribe((set) => {
      const paths = set.size === this.trace.dims.nodes.length ? null
        : this.trace.dims.nodes.filter((n) => set.has(n.id as number)).map((n) => String(n.path))
      this.update((l) => ({ ...l, workspaces: l.workspaces.map((w) => ({ ...w, root: mapLeaf(w.root, id, (leaf) => ({ ...leaf, nodes: paths })) })) }))
    })
    t = { blocks, reveal: new Store<number | null>(null), renderer: null, off }
    this.timelines.set(id, t)
    return t
  }

  /** Node ids from stored paths: nodes absent from this trace are dropped; if none is
   * left, all nodes. */
  private nodeIds(paths: string[] | null): number[] {
    const all = this.trace.dims.nodes
    if (!paths) return all.map((n) => n.id as number)
    const want = new Set(paths)
    const ids = all.filter((n) => want.has(String(n.path))).map((n) => n.id as number)
    return ids.length || !paths.length ? ids : all.map((n) => n.id as number)
  }

  /** The node paths of the last used timeline (a new Timeline area starts with them). */
  private lastNodes(): string[] | null {
    const id = this.targetTimeline()
    if (!id) return null
    const t = this.timelines.get(id)
    if (!t) return this.find(id)?.leaf.nodes ?? null
    const set = t.blocks.get()
    return set.size === this.trace.dims.nodes.length ? null
      : this.trace.dims.nodes.filter((n) => set.has(n.id as number)).map((n) => String(n.path))
  }

  // ---- changes -------------------------------------------------------------------------

  /** A change of the layout, saved unless `save` is false (a border being dragged). */
  update(f: (l: Layout) => Layout, save = true): void {
    const next = f(this.layout.get())
    this.layout.set(next)
    this.prune(next)
    if (save) saveLayout(next)
    this.refresh()
  }

  save(): void {
    saveLayout(this.layout.get())
  }

  private updateWs(id: string, f: (w: WorkspaceDef) => WorkspaceDef, save = true): void {
    this.update((l) => ({ ...l, workspaces: l.workspaces.map((w) => (w.id === id ? f(w) : w)) }), save)
  }

  /** Forgets the state of areas that are gone. */
  private prune(l: Layout): void {
    const ids = new Set(l.workspaces.flatMap((w) => leaves(w.root)).filter((a) => a.view === 'timeline').map((a) => a.id))
    for (const [id, t] of this.timelines) {
      if (!ids.has(id)) { t.off(); this.timelines.delete(id) }
    }
    const wsIds = new Set(l.workspaces.map((w) => w.id))
    for (const id of this.mounted) if (!wsIds.has(id)) this.mounted.delete(id)
  }

  /** The block diagram's node set and window.__r2timeline follow the target timeline. */
  private refresh(): void {
    const id = this.targetTimeline()
    const sel = id ? this.timeline(id).blocks : this.allNodes
    if (this.store.targetBlocks.get() !== sel) this.store.targetBlocks.set(sel)
    const r = this.stripRenderer()
    if (r) window.__r2timeline = r
    this.changes.set(this.changes.get() + 1)
  }

  /** An area was used (a pointer down in it). */
  use(id: string): void {
    if (this.used.get(id) === this.clock) return
    this.used.set(id, ++this.clock)
    this.refresh()
  }

  setRenderer(id: string, r: TimelineRenderer | null): void {
    const t = this.timelines.get(id)
    if (!t || t.renderer === r) return
    t.renderer = r
    this.refresh()
  }

  activate(wsId: string): void {
    if (this.layout.get().active === wsId) return
    this.mounted.add(wsId)
    this.update((l) => ({ ...l, active: wsId }))
  }

  /** A view-local value of an area (the sidebar); kept with the layout. */
  ui(id: string, key: string): unknown {
    return this.find(id)?.leaf.ui?.[key]
  }

  /** Sets a view-local value without a new layout (no new render): saved with the layout. */
  setUi(id: string, key: string, value: unknown): void {
    const found = this.find(id)
    if (!found) return
    found.leaf.ui = { ...found.leaf.ui, [key]: value }
    this.save()
  }

  // ---- areas ---------------------------------------------------------------------------

  private wsOf(areaId: string): WorkspaceDef | null {
    return this.find(areaId)?.ws ?? null
  }

  split(id: string, dir: SplitDir): void {
    const found = this.find(id)
    if (!found) return
    const { leaf } = found
    const added: AreaLeaf = { kind: 'area', id: newId('a'), view: leaf.view,
      ui: leaf.ui ? structuredClone(leaf.ui) : undefined }
    if (leaf.view === 'timeline') {
      const t = this.timelines.get(id)
      const set = t?.blocks.get()
      added.nodes = set ? (set.size === this.trace.dims.nodes.length ? null
        : this.trace.dims.nodes.filter((n) => set.has(n.id as number)).map((n) => String(n.path))) : leaf.nodes
    }
    this.updateWs(found.ws.id, (w) => ({ ...w, maximized: null, root: splitArea(w.root, id, dir, added) }))
  }

  close(id: string): void {
    const ws = this.wsOf(id)
    if (ws) this.updateWs(ws.id, (w) => ({ ...w, maximized: null, root: closeArea(w.root, id) }))
  }

  merge(id: string): void {
    const ws = this.wsOf(id)
    if (ws) this.updateWs(ws.id, (w) => ({ ...w, maximized: null, root: mergeArea(w.root, id) }))
  }

  /** The area shows another view (a new Timeline gets the node set of the last one). */
  setView(id: string, view: ViewType): void {
    const ws = this.wsOf(id)
    if (!ws) return
    const nodes = view === 'timeline' ? this.lastNodes() : undefined
    const fresh = newId('a')
    this.updateWs(ws.id, (w) => ({
      ...w, maximized: w.maximized === id ? fresh : w.maximized,
      root: mapLeaf(w.root, id, (leaf) => ({ kind: 'area', id: fresh, view, nodes, ui: leaf.ui })),
    }))
    this.use(fresh)
  }

  toggleMaximized(id: string): void {
    const ws = this.wsOf(id)
    if (!ws || leaves(ws.root).length < 2 && !ws.maximized) return
    this.updateWs(ws.id, (w) => ({ ...w, maximized: w.maximized === id ? null : id }))
  }

  setRatio(wsId: string, path: string, ratio: number, save: boolean): void {
    this.updateWs(wsId, (w) => ({ ...w, root: setRatio(w.root, path, ratio) }), save)
  }

  // ---- workspaces ----------------------------------------------------------------------

  /** A copy of the active workspace, after it, made active. */
  addCopy(): void {
    const src = this.active
    const copy: WorkspaceDef = { id: newId('w'), name: `${src.name} copy`, root: copyTree(src.root), maximized: null }
    this.mounted.add(copy.id)
    this.update((l) => {
      const at = l.workspaces.findIndex((w) => w.id === src.id)
      const workspaces = [...l.workspaces]
      workspaces.splice(at + 1, 0, copy)
      return { ...l, active: copy.id, workspaces }
    })
  }

  rename(wsId: string, name: string): void {
    const n = name.trim()
    if (n) this.updateWs(wsId, (w) => ({ ...w, name: n }))
  }

  remove(wsId: string): void {
    const l = this.layout.get()
    if (l.workspaces.length < 2) return
    const at = l.workspaces.findIndex((w) => w.id === wsId)
    const workspaces = l.workspaces.filter((w) => w.id !== wsId)
    const active = l.active === wsId ? workspaces[Math.min(at, workspaces.length - 1)].id : l.active
    this.mounted.add(active)
    this.update(() => ({ ...l, active, workspaces }))
  }

  /** Moves a workspace to index `to` (of the list without it). */
  move(wsId: string, to: number): void {
    this.update((l) => {
      const ws = l.workspaces.find((w) => w.id === wsId)
      if (!ws) return l
      const workspaces = l.workspaces.filter((w) => w.id !== wsId)
      workspaces.splice(Math.max(0, Math.min(to, workspaces.length)), 0, ws)
      return { ...l, workspaces }
    })
  }

  resetAll(): void {
    const l = defaultLayout()
    this.mounted.clear()
    this.mounted.add(l.active)
    const tl = l.workspaces.find((w) => w.base === 'timeline')
    if (tl) this.mounted.add(tl.id)
    this.used.clear()
    this.update(() => l)
  }

  // ---- reveal --------------------------------------------------------------------------

  /** Shows a task in the most recently used Timeline area of the active workspace; if it
   * has none, in the default Timeline workspace (added again if it was deleted). */
  reveal(task: number): void {
    let ws = this.active
    let leaf = this.latest(this.timelineLeaves(ws))
    if (!leaf) {
      let found = this.defaultTimeline()
      if (!found) {
        const added: WorkspaceDef = { id: newId('w'), name: 'Timeline', base: 'timeline',
          root: { kind: 'area', id: newId('a'), view: 'timeline' } as LayoutNode }
        this.update((l) => ({ ...l, workspaces: [...l.workspaces, added] }))
        found = this.defaultTimeline()
      }
      if (!found) return
      ws = found.ws
      leaf = found.leaf
      this.activate(ws.id)
    }
    if (ws.maximized && ws.maximized !== leaf.id) this.updateWs(ws.id, (w) => ({ ...w, maximized: null }))
    const id = leaf.id
    this.use(id)
    this.timeline(id).reveal.set(task)
  }
}
