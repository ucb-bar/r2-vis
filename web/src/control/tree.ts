// The Neutrino tree of the control view (views-design 6.3): a force-directed layout of the
// node hierarchy (hierarchy links, repulsion, collision), seeded from a radial tidy layout
// so that a trace always gives the same picture; the root is fixed at the origin.
import { forceCollide, forceLink, forceManyBody, forceSimulation, type Simulation, type SimulationLinkDatum, type SimulationNodeDatum } from 'd3-force'
import type { Trace } from '../data/trace'

export interface TreeNode extends SimulationNodeDatum {
  id: number
  parent: number | null
  depth: number
  name: string
  path: string
  x: number
  y: number
}

export type TreeLink = SimulationLinkDatum<TreeNode> & { source: TreeNode; target: TreeNode }

const LEVEL = 140          // seed radius step per depth (layout units)
const NODE_R = 12          // node radius in layout units (collision)
const SETTLE_TICKS = 300

export class NeutrinoTree {
  readonly nodes: TreeNode[]
  readonly links: TreeLink[]
  private readonly sim: Simulation<TreeNode, TreeLink>

  constructor(trace: Trace) {
    const d = trace.dims.nodes
    this.nodes = d.map((n) => ({ id: n.id as number, parent: n.parent as number | null, depth: n.depth as number,
      name: String(n.name), path: String(n.path), x: 0, y: 0 }))
    const children = new Map<number, number[]>()
    for (const n of this.nodes) if (n.parent !== null) children.set(n.parent, [...(children.get(n.parent) ?? []), n.id])
    const root = this.nodes.find((n) => n.parent === null) ?? this.nodes[0]
    // Radial tidy seed: leaves evenly around the circle in depth-first order, a parent at
    // the mean angle of its children, radius by depth.
    const leaves: number[] = []
    const visit = (id: number) => {
      const c = children.get(id) ?? []
      if (!c.length) leaves.push(id)
      c.forEach(visit)
    }
    visit(root.id)
    const angle = new Float64Array(this.nodes.length)
    leaves.forEach((id, k) => { angle[id] = (2 * Math.PI * k) / Math.max(1, leaves.length) })
    const place = (id: number): number => {
      const c = children.get(id) ?? []
      if (c.length) angle[id] = c.map(place).reduce((x, y) => x + y, 0) / c.length
      return angle[id]
    }
    place(root.id)
    for (const n of this.nodes) {
      n.x = n.depth * LEVEL * Math.cos(angle[n.id] - Math.PI / 2)
      n.y = n.depth * LEVEL * Math.sin(angle[n.id] - Math.PI / 2)
    }
    root.fx = 0
    root.fy = 0
    this.links = this.nodes.filter((n) => n.parent !== null).map((n) => ({ source: this.nodes[n.parent as number], target: n }))
    this.sim = forceSimulation<TreeNode, TreeLink>(this.nodes)
      .force('link', forceLink<TreeNode, TreeLink>(this.links).distance((l) => (l.target.depth === 1 ? LEVEL : LEVEL * 0.6)).strength(0.7))
      .force('charge', forceManyBody<TreeNode>().strength(-60).distanceMax(LEVEL * 3))
      .force('collide', forceCollide<TreeNode>(NODE_R * 1.4))
      .stop()
    // Settle synchronously: the same trace gives the same layout.
    for (let i = 0; i < SETTLE_TICKS; i++) this.sim.tick()
  }

  /** Drags a node to (x, y) (layout units) and lets the others follow; `onTick` redraws. */
  drag(node: TreeNode, x: number, y: number, onTick: () => void): void {
    if (node.parent === null) return   // the root stays fixed
    node.fx = x
    node.fy = y
    this.sim.on('tick', onTick).alpha(Math.max(this.sim.alpha(), 0.3)).restart()
  }

  /** Releases a dragged node (it stays where it was dropped). */
  release(node: TreeNode): void {
    if (node.parent === null) return
    node.x = node.fx ?? node.x
    node.y = node.fy ?? node.y
  }

  stop(): void {
    this.sim.stop()
  }

  get radius(): number {
    return NODE_R
  }
}
