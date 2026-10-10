// Layout of the traffic view: x in hierarchy columns (leaves on the left, root on the
// right), y in rows. Level `L` = the deepest level that is drawn in full; the nodes at depth
// L with children show their subtree as one aggregated row. The strips of a box (a block,
// an aggregated row, the links of a child to its parent) are stacked in slots around the
// box's center; the renderer turns slots into screen pixels (strip heights are fixed in
// pixels, views-design 6.4), and sizes the boxes and buses to the strips they take.
import { CLASS_ORDER, mergedName, type LinkClass, type TBlock, type TBus, type TrafficModel } from './model'

export interface PBlock {
  x0: number
  x1: number
  y: number
  label: string
  path: string
  /** strips attached to it (one per bus it is on) */
  slots: number
  /** rows of space it has (the distance to its neighbors in its column) */
  span: number
}

export interface PBus {
  x: number
  label: string
  path: string
  cls: LinkClass
  /** its attachments (the strips that end on it set its extent) */
  atts: number[]
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
  x1: number
  /** the center row of its box, its slot there (a loop: two slots, its legs) and the
   * box's number of slots */
  yc: number
  slot: number
  slots: number
  /** the bus attachments that it ends on */
  ends: number[]
  /** traffic in both directions over the run: two one-way strips (slots slot and slot + 1) */
  pair: boolean
  /** att and link: the two directions (forward = block to bus, child to parent) */
  fwd: number | null
  rev: number | null
  /** link: the attachment ports each direction passes (its load is the MAX) */
  fwdPorts: number[]
  revPorts: number[]
  /** cross and self: the member resources (summed), and per direction (fwd: in, up) */
  members: number[]
  fwdMembers: number[]
  revMembers: number[]
}

export interface PAgg {
  x0: number
  x1: number
  y: number
  label: string
  node: number
  slots: number
  span: number
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

export const LOOP_LEG = 1.6   // slots from a loop's top leg to its bottom leg

/** Columns from the left: leaf blocks, the leaf buses, then per level up the buses and
 * the blocks of that level (blocks right of their buses: HBM next to its clsbus). */
export function columns(depth: number): { busCol: (d: number) => number; blockCol: (d: number) => number; cols: number } {
  const busCol = (d: number) => (d === depth ? 1 : 2 * (depth - d))
  const blockCol = (d: number) => (d === depth ? 0 : busCol(d) + 1)
  return { busCol, blockCol, cols: depth === 0 ? 3 : 2 * depth + 2 }
}

const classRank = (c: LinkClass) => CLASS_ORDER.indexOf(c)
const noMembers = { fwdPorts: [], revPorts: [], members: [], fwdMembers: [], revMembers: [] }

/** The layout of a level with the visible classes only (views-design 6.5: no space for the
 * hidden classes or their buses). */
export function layout(m: TrafficModel, level: number, visible: Record<LinkClass, boolean>): Layout {
  const D = m.depth
  const d = m.trace.dims
  const { busCol, blockCol, cols } = columns(D)
  // The buses of the visible classes spread evenly over their column.
  const shown = CLASS_ORDER.filter((c) => visible[c])
  const BUS_DX = Object.fromEntries(shown.map((c, k) => [c, (k + 0.5) / shown.length])) as Record<LinkClass, number>
  // Traffic in a direction over the whole run (the layout does not change with the range).
  const busy = (rs: (number | null)[]) => rs.some((r) => r !== null && (d.resources[r].amount as number) > 0)
  const out: Layout = { level, cols, units: 0, blocks: [], buses: [], links: [], aggs: [], bands: [] }
  const placedBuses: TBus[] = []
  let cursor = 0

  /** Places the blocks of a band [y0, y1) clear of the link centers in it (the rows where
   * link groups cross the strips of the blocks: the band's own center, where the node's
   * uplinks (and an aggregated row's links) are, and the centers of the children's bands). */
  const placeBlocks = (blocks: TBlock[], depth: number, y0: number, y1: number, centers: number[]) => {
    const c = blockCol(depth)
    const left = depth === D
    const { at, span } = spread(blocks.length, y0, y1, centers)
    blocks.forEach((b, k) => {
      const y = at[k]
      const x0 = c + 0.08
      const x1 = c + 0.92
      const atts = b.atts.map((att) => ({ att, bus: m.nodes[b.node].buses.find((x) => x.id === d.attachments[att].bus) }))
        .filter((x): x is { att: number; bus: TBus } => x.bus !== undefined && visible[x.bus.cls])
        .sort((p, q) => classRank(p.bus.cls) - classRank(q.bus.cls))
      const pairs = atts.map(({ att }) => busy([d.attachments[att].in_resource as number | null])
        && busy([d.attachments[att].out_resource as number | null]))
      const slots = pairs.reduce((n, p) => n + (p ? 2 : 1), 0)
      out.blocks.push({ x0, x1, y, label: b.label, path: b.key, slots, span })
      let slot = 0
      atts.forEach(({ att, bus }, k) => {
        const a = d.attachments[att]
        out.links.push({ key: `a${att}`, kind: 'att', cls: bus.cls, name: `${bus.path}.${a.name}`, node: b.node,
          x0: left ? x1 : x0, x1: busCol(depth) + BUS_DX[bus.cls], yc: y, slot, slots, ends: [att], pair: pairs[k],
          fwd: a.in_resource as number | null, rev: a.out_resource as number | null, ...noMembers })
        slot += pairs[k] ? 2 : 1
      })
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
      const ax = busCol(n.depth + 1) + 0.3
      const merged = mergedName(n.children.map((c) => m.nodes[c].name))
      const { inner, cross } = m.subtreeLinks(id)
      // Per class: the loop of the links inside (two slots: its legs), then the edge of the
      // links that cross the aggregate's boundary to this level.
      const items: Omit<PLink, 'slot' | 'slots'>[] = []
      const slotOf: number[] = []
      let slots = 0
      for (const cls of shown) {
        const self = inner[cls]
        if (self.fwd.length + self.rev.length) {
          items.push({ key: `s${id}${cls}`, kind: 'self', cls, name: `inside ${n.name}.${merged} (${cls})`,
            // x1: the hairpin may reach to the start of this node's bus column
            node: id, x0: ax, x1: busCol(n.depth), yc: ac, ends: [], pair: false, fwd: null, rev: null, fwdPorts: [], revPorts: [],
            members: [...self.fwd, ...self.rev], fwdMembers: self.fwd, revMembers: self.rev })
          slotOf.push(slots)
          slots += LOOP_LEG + 1
        }
        const keep = cross[cls]
        const bus = n.buses.find((b) => b.cls === cls)
        if (keep.fwd.length && bus) {
          const ends = n.children.flatMap((c) => m.nodes[c].uplinks.filter((l) => l.cls === cls).map((l) => l.parentAtt))
          const pair = busy(keep.fwd) && busy(keep.rev)
          items.push({ key: `x${id}${cls}`, kind: 'cross', cls, name: `${n.name}.${merged} links (${cls})`,
            node: id, x0: ax, x1: busCol(n.depth) + BUS_DX[cls], yc: ac, ends, pair, fwd: null, rev: null, fwdPorts: [], revPorts: [],
            members: [...keep.fwd, ...keep.rev], fwdMembers: keep.fwd, revMembers: keep.rev })
          slotOf.push(slots)
          slots += pair ? 2 : 1
        }
      }
      items.forEach((it, k) => out.links.push({ ...it, slot: slotOf[k], slots }))
      // The box is alone in its band and columns: it may take the band's height.
      out.aggs.push({ x0: 0.08, x1: ax, y: ac, label: `${n.name}.${merged}`, node: id, slots, span: units - 0.4 })
      cursor = y0 + units
      placeBlocks(n.blocks, n.depth, y0, cursor, [ac])
    } else if (!n.children.length) {
      // A leaf: a row more at the center for its uplinks, which cross the strips of its
      // blocks to the other buses of its column.
      const ups = n.uplinks.some((l) => visible[l.cls])
      cursor = y0 + Math.max(1, n.blocks.length) + (ups && n.blocks.length ? 1 : 0)
      placeBlocks(n.blocks, n.depth, y0, cursor, ups ? [(y0 + cursor) / 2] : [])
    } else {
      for (const c of n.children) visit(c)
      if (cursor - y0 < n.blocks.length) cursor = y0 + n.blocks.length
      const centers = n.children.filter((c) => m.nodes[c].uplinks.some((l) => visible[l.cls]))
        .map((c) => out.bands.find((b) => b.label === m.nodes[c].path))
        .filter((b): b is PBand => b !== undefined).map((b) => (b.y0 + b.y1) / 2)
      // and the node's own uplinks, at its band's center
      if (n.uplinks.some((l) => visible[l.cls])) centers.push((y0 + cursor) / 2)
      placeBlocks(n.blocks, n.depth, y0, cursor, centers)
      // Links of the children: from the child's bus to this node's bus, at the center of
      // the child's band, stacked in slots by class.
      for (const c of n.children) {
        const band = out.bands.find((b) => b.label === m.nodes[c].path)
        if (!band) continue
        const ups = m.nodes[c].uplinks.filter((l) => visible[l.cls]).sort((p, q) => classRank(p.cls) - classRank(q.cls))
        const pairs = ups.map((l) => busy([l.up, ...l.upPorts]) && busy([l.down, ...l.downPorts]))
        const slots = pairs.reduce((k, p) => k + (p ? 2 : 1), 0)
        let slot = 0
        ups.forEach((l, k) => {
          out.links.push({ key: `l${l.id}`, kind: 'link', cls: l.cls, name: l.path, node: c,
            x0: busCol(n.depth + 1) + BUS_DX[l.cls], x1: busCol(n.depth) + BUS_DX[l.cls],
            yc: (band.y0 + band.y1) / 2, slot, slots, ends: [l.childAtt, l.parentAtt], pair: pairs[k],
            fwd: l.up, rev: l.down, fwdPorts: l.upPorts, revPorts: l.downPorts, members: [], fwdMembers: [], revMembers: [] })
          slot += pairs[k] ? 2 : 1
        })
      }
    }
    out.bands.push({ y0, y1: cursor, label: n.path, depth: n.depth })
  }
  visit(m.root)
  out.units = cursor
  const used = new Set(out.links.flatMap((l) => l.ends))
  for (const bus of placedBuses) {
    if (!visible[bus.cls]) continue
    const atts = bus.atts.filter((a) => used.has(a))
    if (!atts.length) continue
    out.buses.push({ x: busCol(m.nodes[bus.node].depth) + BUS_DX[bus.cls], label: bus.label, path: bus.path,
      cls: bus.cls, atts })
  }
  return out
}

/** Rows for n blocks in [y0, y1) clear of the centers: the intervals between the centers
 * (and the band's edges) share the blocks, each next block to the interval where the step
 * stays the largest. In an interval the blocks are a step apart and a step from a center;
 * half a step from an edge (the next band's blocks are as far on the other side). `span`:
 * the smallest step (the room of a box). */
export function spread(n: number, y0: number, y1: number, centers: number[]): { at: number[]; span: number } {
  const cuts = [...centers].filter((c) => c > y0 && c < y1).sort((p, q) => p - q)
  const ivs = [y0, ...cuts].map((p, k) => ({ p, q: k < cuts.length ? cuts[k] : y1, top: k === 0, bot: k === cuts.length, m: 0 }))
  // the step with m blocks: the edges count half a step, the centers a full one
  const step = (v: { p: number; q: number; top: boolean; bot: boolean }, m: number) =>
    (v.q - v.p) / (m + (v.top ? -0.5 : 0) + (v.bot ? -0.5 : 0) + 1)
  for (let k = 0; k < n; k++) {
    let best = ivs[0]
    for (const v of ivs) if (step(v, v.m + 1) > step(best, best.m + 1)) best = v
    best.m++
  }
  const at: number[] = []
  let span = Infinity
  for (const v of ivs) {
    if (!v.m) continue
    const st = step(v, v.m)
    span = Math.min(span, st)
    const first = v.p + (v.top ? 0.5 : 1) * st
    for (let j = 0; j < v.m; j++) at.push(first + j * st)
  }
  return { at, span: Number.isFinite(span) ? span : y1 - y0 }
}
