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
  /** the other resources of each direction (its load is the MAX): the attachment ports
   * it passes (up = child bus out, parent bus in; down = parent bus out, child bus in) and
   * the write channels of the link and those ports (raw 1.5) */
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
  /** links between two buses of this node (hashed links in front of banks): `child` and
   * `childAtt` are the from end, `up` = ab (from -> to) */
  inlinks: TLink[]
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
      children: [], buses: [], blocks: [], uplinks: [], inlinks: [],
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
    const ports = (...rs: unknown[]) => rs.filter((r): r is number => r !== null && r !== undefined)
    for (const l of d.links) {
      const up = l.up_dir as string | null
      const from = busById.get(d.attachments[l.from_attachment as number].bus as number)
      const to = busById.get(d.attachments[l.to_attachment as number].bus as number)
      const inside = l.cache === null && up === null && from && to && from.node === to.node
      if (l.cache !== null || ((up !== 'ab' && up !== 'ba') && !inside)) { this.undrawn.push(String(l.path)); continue }
      const dir = inside ? 'ab' : up
      const childAtt = (dir === 'ab' ? l.from_attachment : l.to_attachment) as number
      const parentAtt = (dir === 'ab' ? l.to_attachment : l.from_attachment) as number
      const childBus = busById.get(d.attachments[childAtt].bus as number)
      if (!childBus) continue
      const a = d.attachments[childAtt]
      const b = d.attachments[parentAtt]
      const upWr = (dir === 'ab' ? l.ab_wr_resource : l.ba_wr_resource) ?? null
      const downWr = (dir === 'ab' ? l.ba_wr_resource : l.ab_wr_resource) ?? null
      const link: TLink = { id: l.id as number, path: String(l.path), child: childBus.node,
        cls: childBus.cls, up: (dir === 'ab' ? l.ab_resource : l.ba_resource) as number,
        down: (dir === 'ab' ? l.ba_resource : l.ab_resource) as number, childAtt, parentAtt,
        upPorts: ports(a.out_resource, b.in_resource, upWr, a.out_wr_resource, b.in_wr_resource),
        downPorts: ports(b.out_resource, a.in_resource, downWr, b.out_wr_resource, a.in_wr_resource) }
      if (inside) nodes[childBus.node].inlinks.push(link)
      else nodes[childBus.node].uplinks.push(link)
    }
    // Blocks in a fixed order: Neutrino, compute, memories (banks b2 before b10).
    const rank = (b: TBlock) => (b.label === 'neutrino' ? 0 : d.attachments[b.atts[0]].component_type === 'memory' ? 2 : 1)
    for (const n of nodes) n.blocks.sort((x, y) => rank(x) - rank(y) || x.label.localeCompare(y.label, 'en', { numeric: true }))
    this.nodes = nodes
    this.depth = Math.max(...nodes.map((n) => n.depth))
    this.root = nodes.find((n) => d.nodes[n.id].parent === null)?.id ?? 0
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

/** The other resources of an attachment's two directions (in: component to bus, out: bus
 * to component): its write channels, and for a memory its port and write port (reads
 * leave the memory, writes enter it; a memory without a write port has one port for
 * both). */
export function attachmentExtras(trace: Trace, att: number): { fwd: number[]; rev: number[] } {
  const d = trace.dims
  const a = d.attachments[att]
  const ok = (r: unknown): r is number => r !== null && r !== undefined
  const fwd = [a.in_wr_resource].filter(ok)
  const rev = [a.out_wr_resource].filter(ok)
  if (a.component_type === 'memory') {
    const mem = d.memories.find((x) => x.path === a.component)
    if (mem && ok(mem.port)) {
      fwd.push(mem.port)
      rev.push(ok(mem.wport) ? mem.wport : mem.port)
    }
  }
  return { fwd, rev }
}
