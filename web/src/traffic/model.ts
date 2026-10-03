// The fabric topology for the traffic view (views-design Section 3): per node its buses,
// its blocks (components attached to its buses) and the bridges to its parent.
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

export interface TBridge {
  id: number
  path: string
  child: number         // child node
  cls: LinkClass
  up: number            // resource child -> parent (ab)
  down: number          // resource parent -> child (ba)
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
  bridges: TBridge[]    // the bridges of this node to its parent
}

export class TrafficModel {
  readonly trace: Trace
  readonly nodes: TNode[]
  readonly depth: number          // depth of the deepest node
  readonly root: number

  constructor(trace: Trace) {
    this.trace = trace
    const d = trace.dims
    const nodes: TNode[] = d.nodes.map((n) => ({
      id: n.id as number, path: String(n.path), name: String(n.name), depth: n.depth as number,
      children: [], buses: [], blocks: [], bridges: [],
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
      if (a.component_type === 'bridge') continue
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
    for (const br of d.bridges) {
      if (br.type !== 'child') continue
      const childBus = busById.get(d.attachments[br.a_attachment as number].bus as number)
      if (!childBus) continue
      const a = d.attachments[br.a_attachment as number]   // on the child bus
      const b = d.attachments[br.b_attachment as number]   // on the parent bus
      const ports = (...rs: unknown[]) => rs.filter((r): r is number => r !== null && r !== undefined)
      nodes[childBus.node].bridges.push({ id: br.id as number, path: String(br.path), child: childBus.node,
        cls: childBus.cls, up: br.ab_resource as number, down: br.ba_resource as number,
        upPorts: ports(a.out_resource, b.in_resource), downPorts: ports(b.out_resource, a.in_resource) })
    }
    // Blocks in a fixed order: Neutrino, compute, memories.
    const rank = (b: TBlock) => (b.label === 'neutrino' ? 0 : d.attachments[b.atts[0]].component_type === 'memory' ? 2 : 1)
    for (const n of nodes) n.blocks.sort((x, y) => rank(x) - rank(y) || x.label.localeCompare(y.label))
    this.nodes = nodes
    this.depth = Math.max(...nodes.map((n) => n.depth))
    this.root = nodes.find((n) => d.nodes[n.id].parent === null)?.id ?? 0
  }

  /** All resources of the links inside a node's subtree, per class (its buses' ports and
   * the bridges between its descendants), and the bridges from its children (cross). */
  subtreeLinks(node: number): { inner: Record<LinkClass, number[]>; cross: Record<LinkClass, number[]> } {
    const inner: Record<LinkClass, number[]> = { global: [], local: [], control: [] }
    const cross: Record<LinkClass, number[]> = { global: [], local: [], control: [] }
    const visit = (id: number, top: boolean) => {
      const n = this.nodes[id]
      for (const bus of n.buses) {
        for (const att of bus.atts) {
          const a = this.trace.dims.attachments[att]
          // The parent-side ports of the node's own bridges are not inside the subtree.
          for (const r of [a.in_resource, a.out_resource]) if (r !== null) inner[bus.cls].push(r as number)
        }
      }
      for (const br of n.bridges) (top ? cross : inner)[br.cls].push(br.up, br.down)
      for (const c of n.children) visit(c, false)
    }
    for (const c of this.nodes[node].children) visit(c, true)
    return { inner, cross }
  }
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
