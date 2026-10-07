// Layout of the traffic view in abstract units: x in hierarchy columns (leaves on the
// left, root on the right), y in rows. Level `L` = the deepest level that is drawn in
// full; the nodes at depth L with children show their subtree as one aggregated row.
import { CLASS_ORDER, mergedName, type LinkClass, type TBlock, type TBus, type TrafficModel } from './model'

export interface PBlock {
  x0: number
  x1: number
  y: number
  label: string
  path: string
}

export interface PBus {
  x: number
  y0: number
  y1: number
  label: string
  path: string
  cls: LinkClass
}

export type LinkKind = 'att' | 'link' | 'cross' | 'self'

export interface PLink {
  key: string
  kind: LinkKind
  cls: LinkClass
  name: string
  /** the node whose bus (or subtree) the link belongs to */
  node: number
  x0: number
  y0: number
  x1: number
  y1: number
  /** att and link: the two directions (forward = block to bus, child to parent) */
  fwd: number | null
  rev: number | null
  /** link: the attachment ports each direction passes (its load is the MAX) */
  fwdPorts: number[]
  revPorts: number[]
  /** cross and self: the member resources (summed) */
  members: number[]
}

export interface PAgg {
  x0: number
  x1: number
  y0: number
  y1: number
  label: string
  node: number
}

export interface PBand {
  y0: number
  y1: number
  label: string
  depth: number
}

export interface Layout {
  level: number
  cols: number
  units: number
  blocks: PBlock[]
  buses: PBus[]
  links: PLink[]
  aggs: PAgg[]
  bands: PBand[]
}

// Position of a class's bus inside its bus column, and of its links inside a row.
const BUS_DX: Record<LinkClass, number> = { control: 0.2, local: 0.5, global: 0.8 }
const ROW_DY: Record<LinkClass, number> = { control: -0.22, local: 0, global: 0.22 }
const LINK_DY = 0.44     // links to the parent: at the band's center, apart per class

/** Columns from the left: leaf blocks, the leaf buses, then per level up the buses and
 * the blocks of that level (blocks right of their buses: HBM next to its clsbus). */
export function columns(depth: number): { busCol: (d: number) => number; blockCol: (d: number) => number; cols: number } {
  const busCol = (d: number) => (d === depth ? 1 : 2 * (depth - d))
  const blockCol = (d: number) => (d === depth ? 0 : busCol(d) + 1)
  return { busCol, blockCol, cols: depth === 0 ? 3 : 2 * depth + 2 }
}

export function layout(m: TrafficModel, level: number): Layout {
  const D = m.depth
  const d = m.trace.dims
  const { busCol, blockCol, cols } = columns(D)
  const out: Layout = { level, cols, units: 0, blocks: [], buses: [], links: [], aggs: [], bands: [] }
  const attY = new Map<number, number>()   // attachment -> y of its link at the bus
  const placedBuses: TBus[] = []
  let cursor = 0

  const placeBlocks = (blocks: TBlock[], depth: number, y0: number, y1: number) => {
    const c = blockCol(depth)
    const left = depth === D
    // Right of their buses, the blocks leave the band's center to the links.
    const mid = (y0 + y1) / 2
    const gap = !left && y1 - y0 > blocks.length + 1 ? 1 : 0
    const above = Math.ceil(blocks.length / 2)
    const slotY = (k: number): number => {
      if (!gap) return y0 + ((k + 0.5) * (y1 - y0)) / blocks.length
      return k < above ? y0 + ((k + 0.5) * (mid - gap / 2 - y0)) / above
        : mid + gap / 2 + ((k - above + 0.5) * (y1 - mid - gap / 2)) / (blocks.length - above)
    }
    blocks.forEach((b, k) => {
      const y = slotY(k)
      const x0 = c + 0.08
      const x1 = c + 0.92
      out.blocks.push({ x0, x1, y, label: b.label, path: b.key })
      for (const att of b.atts) {
        const bus = m.nodes[b.node].buses.find((x) => x.id === d.attachments[att].bus)
        if (!bus) continue
        const ly = y + ROW_DY[bus.cls]
        attY.set(att, ly)
        const a = d.attachments[att]
        out.links.push({ key: `a${att}`, kind: 'att', cls: bus.cls, name: `${bus.path}.${a.name}`, node: b.node,
          x0: left ? x1 : x0, y0: ly, x1: busCol(depth) + BUS_DX[bus.cls], y1: ly,
          fwd: a.in_resource as number | null, rev: a.out_resource as number | null, fwdPorts: [], revPorts: [], members: [] })
      }
    })
  }

  const visit = (id: number) => {
    const n = m.nodes[id]
    const y0 = cursor
    placedBuses.push(...n.buses)
    if (n.children.length && n.depth === level && level < D) {
      // Aggregated: the subtree below is one row; the node's own blocks next to its buses.
      // Two rows more than its blocks: the row and the links at the center are clear.
      const units = n.blocks.length + 2
      const ac = y0 + units / 2
      const ax = busCol(n.depth + 1) + 0.85
      const merged = mergedName(n.children.map((c) => m.nodes[c].name))
      out.aggs.push({ x0: 0.08, x1: ax, y0: ac - 0.42, y1: ac + 0.42, label: `${n.name}.${merged}`, node: id })
      const { inner, cross } = m.subtreeLinks(id)
      for (const cls of CLASS_ORDER) {
        const ly = ac + ROW_DY[cls]
        // Links that cross the aggregate's boundary keep their edge to this level; the
        // links inside it become one loop out of and back into the row.
        const keep = cross[cls]
        const self = inner[cls]
        const bus = n.buses.find((b) => b.cls === cls)
        if (keep.length && bus) {
          out.links.push({ key: `x${id}${cls}`, kind: 'cross', cls, name: `${n.name}.${merged} links (${cls})`,
            node: id, x0: ax, y0: ly, x1: busCol(n.depth) + BUS_DX[cls], y1: ly, fwd: null, rev: null, fwdPorts: [], revPorts: [], members: keep })
          // The parent-side attachments of the children's links sit on this edge.
          for (const c of n.children) for (const l of m.nodes[c].uplinks) {
            if (l.cls === cls) attY.set(l.parentAtt, ly)
          }
        }
        if (self.length) {
          out.links.push({ key: `s${id}${cls}`, kind: 'self', cls, name: `inside ${n.name}.${merged} (${cls})`,
            node: id, x0: ax, y0: ac, x1: ax, y1: ac, fwd: null, rev: null, fwdPorts: [], revPorts: [], members: self })
        }
      }
      cursor = y0 + units
      placeBlocks(n.blocks, n.depth, y0, cursor)
    } else if (!n.children.length) {
      cursor = y0 + Math.max(1, n.blocks.length)
      placeBlocks(n.blocks, n.depth, y0, cursor)
    } else {
      for (const c of n.children) visit(c)
      if (cursor - y0 < n.blocks.length) cursor = y0 + n.blocks.length
      placeBlocks(n.blocks, n.depth, y0, cursor)
      // Links of the children: from the child's bus to this node's bus, at the child's band.
      for (const c of n.children) {
        const band = out.bands.find((b) => b.label === m.nodes[c].path)
        if (!band) continue
        for (const l of m.nodes[c].uplinks) {
          const ly = (band.y0 + band.y1) / 2 + Math.sign(ROW_DY[l.cls]) * LINK_DY
          attY.set(l.childAtt, ly)
          attY.set(l.parentAtt, ly)
          out.links.push({ key: `l${l.id}`, kind: 'link', cls: l.cls, name: l.path, node: c,
            x0: busCol(n.depth + 1) + BUS_DX[l.cls], y0: ly, x1: busCol(n.depth) + BUS_DX[l.cls], y1: ly,
            fwd: l.up, rev: l.down, fwdPorts: l.upPorts, revPorts: l.downPorts, members: [] })
        }
      }
    }
    out.bands.push({ y0, y1: cursor, label: n.path, depth: n.depth })
  }
  visit(m.root)
  out.units = cursor
  for (const bus of placedBuses) {
    const ys = bus.atts.map((a) => attY.get(a)).filter((y): y is number => y !== undefined)
    if (!ys.length) continue
    out.buses.push({ x: busCol(m.nodes[bus.node].depth) + BUS_DX[bus.cls], y0: Math.min(...ys) - 0.3,
      y1: Math.max(...ys) + 0.3, label: bus.label, path: bus.path, cls: bus.cls })
  }
  return out
}
