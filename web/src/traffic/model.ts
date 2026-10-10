// The fabric topology for the traffic view (views-design Section 3): per node its buses,
// its blocks (components attached to its buses) and its links to its parent's buses.
import type { Trace } from '../data/trace'

export type LinkClass = 'global' | 'local' | 'control'
export const CLASS_ORDER: LinkClass[] = ['control', 'local', 'global']

export interface TBus {
  id: number
  path: string
  label: string
  node: number
  cls: LinkClass
  atts: number[]
}

export interface TBlock {
  key: string           // component path
  label: string
  node: number
  atts: number[]        // its attachments (one per bus it is on)
}

/** A fabric link with a hierarchy direction (links.up_dir), from a node's bus to its
 * parent's bus. */
export interface TLink {
  id: number
  path: string
  child: number         // child node
  cls: LinkClass
  up: number            // resource child -> parent
  down: number          // resource parent -> child
  childAtt: number      // its end attachment on the child's bus
  parentAtt: number     // its end attachment on the parent's bus
  /** the attachment ports each direction passes: up = child bus out, parent bus in;
   * down = parent bus out, child bus in */
  upPorts: number[]
  downPorts: number[]
}

export interface TNode {
  id: number
  path: string
  name: string
  depth: number
  children: number[]
  buses: TBus[]
  blocks: TBlock[]
  uplinks: TLink[]      // the links of this node to its parent
}

export class TrafficModel {
  readonly trace: Trace
  readonly nodes: TNode[]
  readonly depth: number          // depth of the deepest node
  readonly root: number
  /** paths of the links the view does not draw (caches; no hierarchy direction) */
  readonly undrawn: string[]

  constructor(trace: Trace) {
    this.trace = trace
    const d = trace.dims
    const nodes: TNode[] = d.nodes.map((n) => ({
      id: n.id as number, path: String(n.path), name: String(n.name), depth: n.depth as number,
      children: [], buses: [], blocks: [], uplinks: [],
    }))
    for (const n of d.nodes) if (n.parent !== null) nodes[n.parent as number].children.push(n.id as number)
    const busById = new Map<number, TBus>()
    for (const b of d.buses) {
      const node = nodes[b.node as number]
      const bus: TBus = { id: b.id as number, path: String(b.path), label: String(b.path).slice(node.path.length + 1),
        node: node.id, cls: (String(b.class) as LinkClass), atts: [] }
      busById.set(bus.id, bus)
      node.buses.push(bus)
    }
    const blockOf = new Map<string, TBlock>()
    for (const a of d.attachments) {
      const bus = busById.get(a.bus as number)
      if (!bus) continue
      bus.atts.push(a.id as number)
      if (a.component_type === 'link') continue
      const key = String(a.component)
      let blk = blockOf.get(key)
      if (!blk) {
        const node = nodes[bus.node]
        blk = { key, label: key.startsWith(`${node.path}.`) ? key.slice(node.path.length + 1) : key === node.path ? 'neutrino' : key,
          node: bus.node, atts: [] }
        blockOf.set(key, blk)
        node.blocks.push(blk)
      }
      blk.atts.push(a.id as number)
    }
    // Links with a hierarchy direction; a cache link, or one between unrelated nodes or
    // within one node, has no place in this layout (none in the current configurations).
    this.undrawn = []
    for (const l of d.links) {
      const up = l.up_dir as string | null
      if (l.cache !== null || (up !== 'ab' && up !== 'ba')) { this.undrawn.push(String(l.path)); continue }
      const childAtt = (up === 'ab' ? l.from_attachment : l.to_attachment) as number
      const parentAtt = (up === 'ab' ? l.to_attachment : l.from_attachment) as number
      const childBus = busById.get(d.attachments[childAtt].bus as number)
      if (!childBus) continue
      const a = d.attachments[childAtt]
      const b = d.attachments[parentAtt]
      const ports = (...rs: unknown[]) => rs.filter((r): r is number => r !== null && r !== undefined)
      nodes[childBus.node].uplinks.push({ id: l.id as number, path: String(l.path), child: childBus.node,
        cls: childBus.cls, up: (up === 'ab' ? l.ab_resource : l.ba_resource) as number,
        down: (up === 'ab' ? l.ba_resource : l.ab_resource) as number, childAtt, parentAtt,
        upPorts: ports(a.out_resource, b.in_resource), downPorts: ports(b.out_resource, a.in_resource) })
    }
    // Blocks in a fixed order: Neutrino, compute, memories.
    const rank = (b: TBlock) => (b.label === 'neutrino' ? 0 : d.attachments[b.atts[0]].component_type === 'memory' ? 2 : 1)
    for (const n of nodes) n.blocks.sort((x, y) => rank(x) - rank(y) || x.label.localeCompare(y.label))
    this.nodes = nodes
    this.depth = Math.max(...nodes.map((n) => n.depth))
    this.root = nodes.find((n) => d.nodes[n.id].parent === null)?.id ?? 0
  }

  /** The links inside a node's subtree per class, by direction (fwd: ports in and links
   * up; rev: ports out and links down): its descendants' bus ports and the links between
   * them (inner), and the links from its children (cross). */
  subtreeLinks(node: number): { inner: Record<LinkClass, Dirs>; cross: Record<LinkClass, Dirs> } {
    const empty = (): Record<LinkClass, Dirs> => ({ global: { fwd: [], rev: [] }, local: { fwd: [], rev: [] }, control: { fwd: [], rev: [] } })
    const inner = empty()
    const cross = empty()
    const visit = (id: number, top: boolean) => {
      const n = this.nodes[id]
      for (const bus of n.buses) {
        for (const att of bus.atts) {
          const a = this.trace.dims.attachments[att]
          // The parent-side ports of the node's own links are not inside the subtree.
          if (a.in_resource !== null) inner[bus.cls].fwd.push(a.in_resource as number)
          if (a.out_resource !== null) inner[bus.cls].rev.push(a.out_resource as number)
        }
      }
      for (const l of n.uplinks) {
        const to = top ? cross : inner
        to[l.cls].fwd.push(l.up)
        to[l.cls].rev.push(l.down)
      }
      for (const c of n.children) visit(c, false)
    }
    for (const c of this.nodes[node].children) visit(c, true)
    return { inner, cross }
  }
}

/** The resources of the two directions of a group of links. */
export interface Dirs {
  fwd: number[]
  rev: number[]
}

/** Names of a group of sibling nodes with the common prefix merged: "sm0-3", "sm{0,2,5}". */
export function mergedName(names: string[]): string {
  if (names.length === 1) return names[0]
  const m = names.map((n) => /^(.*?)(\d+)$/.exec(n))
  if (m.every((x) => x && x[1] === m[0]?.[1])) {
    const nums = m.map((x) => Number(x?.[2])).sort((a, b) => a - b)
    const run = nums.every((v, i) => i === 0 || v === nums[i - 1] + 1)
    return `${m[0]?.[1]}${run ? `${nums[0]}-${nums[nums.length - 1]}` : `{${nums.join(',')}}`}`
  }
  return names.join(', ')
}
