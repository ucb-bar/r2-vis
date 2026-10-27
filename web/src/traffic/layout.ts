// Layout of the traffic view: x in hierarchy columns (leaves on the left, root on the
// right); y in px, by interval packing (views-design 6.6). The layout draws a cut of the
// merge tree (merge.ts): an open node shows its children's runs, an open group its parts; a
// closed group (or a closed node) is one box with the links that leave it and loops for
// the links inside it. The layout gives the boxes, the links and the order in which pack()
// places them; pack() gives every box and link group its y.
import type { Trace } from '../data/trace'
import { MergeTree, type MGroup } from './merge'
import { attachmentExtras, CLASS_ORDER, type LinkClass, type TBlock, type TBus, type TLink, type TrafficModel } from './model'

export interface PBlock {
  x0: number
  x1: number
  label: string
  path: string
  /** its node (a block group: the node of its blocks) */
  node: number
  /** strips attached to it (one per bus it is on, two for a link with traffic both ways) */
  slots: number
  /** its center (px, from pack) */
  yc: number
  /** a merged block group: the key that a click opens */
  open?: string
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
  /** cross and self: the member nodes of the group (their subtrees) */
  group: number[]
  x0: number
  x1: number
  /** the center (px, from pack) of its box or link group, its slot there (a loop: two
   * slots, its legs) and the group's number of slots */
  yc: number
  slot: number
  slots: number
  /** the bus attachments that it ends on */
  ends: number[]
  /** its strips, in slots slot, slot + 1, ... (a loop: none, its legs are its two slots) */
  strips: PStrip[]
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

/** A strip: the direction it shows (0 = forward; null: a link with no traffic over the run)
 * and its channel: all (the busiest of the direction's read and write channels) or, with
 * the channels shown separately, read or write. */
export interface PStrip {
  dir: 0 | 1 | null
  ch: 'all' | 'read' | 'write'
}

/** The strips of a link from its two directions' resources: one per direction that carried
 * traffic over the whole run (the layout does not change with the range); with `separate`,
 * one per channel (read, write) that did; none: one still strip. */
export function channelStrips(d: Trace['dims'], dirs: [number[], number[]], separate: boolean): PStrip[] {
  const busy = (rs: number[]) => rs.some((r) => (d.resources[r].amount as number) > 0)
  const out: PStrip[] = []
  for (const k of [0, 1] as const) {
    const rs = dirs[k]
    if (!separate) {
      if (busy(rs)) out.push({ dir: k, ch: 'all' })
      continue
    }
    if (busy(rs.filter((r) => !d.resources[r].write))) out.push({ dir: k, ch: 'read' })
    if (busy(rs.filter((r) => d.resources[r].write))) out.push({ dir: k, ch: 'write' })
  }
  return out.length ? out : [{ dir: null, ch: 'all' }]
}

/** A closed group of nodes (or one closed node): one box. */
export interface PAgg {
  x0: number
  x1: number
  label: string
  node: number
  slots: number
  yc: number
  /** the key that a click opens (the group, or the node) */
  open: string
}

/** What a band holds: an open node, an open merge group (its parts), or a closed group
 * of nodes (its box). */
export type BandKind = 'node' | 'group' | 'agg'

/** The px rows of a band (from pack), `nest` open nodes deep (0: the root), with the units
 * placed in it (nested bands' units included). */
export interface PBand {
  y0: number
  y1: number
  label: string
  key: string
  nest: number
  kind: BandKind
  units: PUnit[]
}

/** A split block group (memory banks): no band; a thin bracket beside its members, which
 * a click merges back. `level`: the depth of the split groups inside it (0: none). */
export interface PBracket {
  key: string
  label: string
  blocks: PBlock[]
  level: number
  /** blocks of the deepest nodes: on the left of the boxes (their strips go right) */
  left: boolean
}

/** A packing unit: a box with the strips that end on it, or the strips of one link. */
export interface PUnit {
  box: PBlock | PAgg | null
  links: PLink[]
  /** the band it is in */
  band: string
}

/** The order of packing: units, and the opening and closing of a band (a band's units go
 * no higher than the bottom of everything placed before the band opened). */
export type PStep = PUnit | { open: string; label: string; kind: BandKind } | { close: string }

export interface Layout {
  /** the depth of the deepest open node */
  level: number
  cols: number
  blocks: PBlock[]
  buses: PBus[]
  links: PLink[]
  aggs: PAgg[]
  bands: PBand[]
  brackets: PBracket[]
  seq: PStep[]
  /** the height of the packed drawing (px, from pack) */
  height: number
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

/** The layout of a cut of the merge tree, with the visible classes only (views-design 6.5:
 * no space for the hidden classes or their buses). The packing order: per open node the
 * items of its runs (an open child node followed by its links to the node); links and
 * strips by class. */
export function layout(m: TrafficModel, tree: MergeTree, isOpen: (key: string) => boolean,
  visible: Record<LinkClass, boolean>, separate: boolean): Layout {
  const D = m.depth
  const d = m.trace.dims
  const { busCol, blockCol, cols } = columns(D)
  // The buses of the visible classes spread evenly over their column.
  const shown = CLASS_ORDER.filter((c) => visible[c])
  // The buses of the visible classes spread over their column: per depth, each class has as
  // many places as the most buses of that class on one node (hbmbus beside clsbus).
  const most = new Map<string, number>()
  for (const n of m.nodes) {
    for (const c of shown) {
      const k = `${n.depth}|${c}`
      most.set(k, Math.max(most.get(k) ?? 1, n.buses.filter((b) => b.cls === c).length))
    }
  }
  const busX = new Map<number, number>()
  for (const n of m.nodes) {
    const places = shown.reduce((acc, c) => acc + (most.get(`${n.depth}|${c}`) ?? 1), 0)
    let base = 0
    for (const c of shown) {
      n.buses.filter((b) => b.cls === c).forEach((b, k) => busX.set(b.id, busCol(n.depth) + (base + k + 0.5) / places))
      base += most.get(`${n.depth}|${c}`) ?? 1
    }
  }
  const attX = (att: number) => busX.get(d.attachments[att].bus as number) ?? 0
  const strips = (fwd: (number | null)[], rev: (number | null)[]) =>
    channelStrips(d, [fwd.filter((r): r is number => r !== null), rev.filter((r): r is number => r !== null)], separate)
  const out: Layout = { level: 0, cols, blocks: [], buses: [], links: [], aggs: [], bands: [], brackets: [], seq: [], height: 0 }
  const placedBuses: TBus[] = []
  const unit = (box: PBlock | PAgg | null, links: PLink[], band: string) => {
    out.seq.push({ box, links, band })
    out.links.push(...links)
  }
  const noLink = { group: [] as number[], fwdPorts: [], revPorts: [], members: [], fwdMembers: [], revMembers: [] }

  /** A block of node `node` (in its node's block column): its box and its attachments. */
  const placeBlock = (b: TBlock, band: string) => {
    const depth = m.nodes[b.node].depth
    const c = blockCol(depth)
    const left = depth === D
    const x0 = c + 0.08
    const x1 = c + 0.92
    const atts = b.atts.map((att) => ({ att, bus: m.nodes[b.node].buses.find((x) => x.id === d.attachments[att].bus) }))
      .filter((x): x is { att: number; bus: TBus } => x.bus !== undefined && visible[x.bus.cls])
      .sort((p, q) => classRank(p.bus.cls) - classRank(q.bus.cls))
    const extras = atts.map(({ att }) => attachmentExtras(m.trace, att))
    const each = atts.map(({ att }, k) => strips([d.attachments[att].in_resource as number | null, ...extras[k].fwd],
      [d.attachments[att].out_resource as number | null, ...extras[k].rev]))
    const slots = each.reduce((n, p) => n + p.length, 0)
    const block: PBlock = { x0, x1, label: b.label, path: b.key, node: b.node, slots, yc: 0 }
    out.blocks.push(block)
    let slot = 0
    const links = atts.map(({ att, bus }, k): PLink => {
      const a = d.attachments[att]
      const l: PLink = { key: `a${att}`, kind: 'att', cls: bus.cls, name: `${bus.path}.${a.name}`, node: b.node,
        x0: left ? x1 : x0, x1: busX.get(bus.id) ?? 0, yc: 0, slot, slots, ends: [att], strips: each[k],
        fwd: a.in_resource as number | null, rev: a.out_resource as number | null, ...noLink,
        fwdPorts: extras[k].fwd, revPorts: extras[k].rev }
      slot += each[k].length
      return l
    })
    unit(block, links, band)
  }

  /** A closed group of blocks: one block box with, per class, the strip of its members'
   * ports summed. */
  const placeBlockGroup = (g: MGroup, band: string) => {
    const depth = m.nodes[g.parent].depth
    const c = blockCol(depth)
    const left = depth === D
    const x0 = c + 0.08
    const x1 = c + 0.92
    const { cross, ends } = tree.groupLinks(g)
    const items: Omit<PLink, 'slot' | 'slots'>[] = []
    for (const cls of shown) {
      const k = cross[cls]
      if (!k.fwd.length && !k.rev.length) continue
      items.push({ key: `${g.key}${cls}`, kind: 'cross', cls, name: `${m.nodes[g.parent].path}.${g.label} (${cls})`,
        node: g.parent, group: [], x0: left ? x1 : x0, x1: attX(ends[cls][0]), yc: 0, ends: ends[cls],
        strips: strips(k.fwd, k.rev), fwd: null, rev: null, fwdPorts: [], revPorts: [],
        members: [...k.fwd, ...k.rev], fwdMembers: k.fwd, revMembers: k.rev })
    }
    let slot = 0
    const slotOf = items.map((it) => { const s0 = slot; slot += it.strips.length; return s0 })
    const block: PBlock = { x0, x1, label: g.label, path: g.key, node: g.parent, slots: slot, yc: 0, open: g.key }
    out.blocks.push(block)
    unit(block, items.map((it, k) => ({ ...it, slot: slotOf[k], slots: slot })), band)
  }

  /** A closed group of child nodes (or one closed child node): one box over the columns
   * of their subtrees; per class the loop of the links inside (two slots: its legs), then
   * the edge of the links that leave it. */
  const placeAgg = (g: MGroup, band: string) => {
    const p = m.nodes[g.parent]
    const ax = busCol(p.depth + 1) + 0.3
    const nodes = MergeTree.nodesOf(g)
    const { inner, cross, ends } = tree.groupLinks(g)
    const name = `${p.name}.${g.label}`
    const items: Omit<PLink, 'slot' | 'slots'>[] = []
    const slotOf: number[] = []
    let slots = 0
    for (const cls of shown) {
      const self = inner[cls]
      if (self.fwd.length + self.rev.length) {
        items.push({ key: `s${g.key}${cls}`, kind: 'self', cls, name: `inside ${name} (${cls})`,
          // x1: the hairpin may reach to the start of the parent's bus column
          node: g.parent, group: nodes, x0: ax, x1: busCol(p.depth), yc: 0, ends: [], strips: [], fwd: null, rev: null,
          fwdPorts: [], revPorts: [], members: [...self.fwd, ...self.rev], fwdMembers: self.fwd, revMembers: self.rev })
        slotOf.push(slots)
        slots += LOOP_LEG + 1
      }
      const keep = cross[cls]
      if (keep.fwd.length && p.buses.some((b) => b.cls === cls)) {
        const st = strips(keep.fwd, keep.rev)
        items.push({ key: `x${g.key}${cls}`, kind: 'cross', cls, name: `${name} links (${cls})`,
          node: g.parent, group: nodes, x0: ax, x1: attX(ends[cls][0]), yc: 0, ends: ends[cls], strips: st,
          fwd: null, rev: null, fwdPorts: [], revPorts: [], members: [...keep.fwd, ...keep.rev], fwdMembers: keep.fwd,
          revMembers: keep.rev })
        slotOf.push(slots)
        slots += st.length
      }
    }
    const agg: PAgg = { x0: 0.08, x1: ax, label: name, node: g.parent, slots, yc: 0, open: g.key }
    out.aggs.push(agg)
    unit(agg, items.map((it, k) => ({ ...it, slot: slotOf[k], slots })), band)
  }

  /** The links of a child to its parent (or between two buses of one node): one unit per
   * link (by class). */
  const placeLinks = (links: TLink[], band: string) => {
    const ups = links.filter((l) => visible[l.cls]).sort((p, q) => classRank(p.cls) - classRank(q.cls))
    for (const l of ups) {
      const st = strips([l.up, ...l.upPorts], [l.down, ...l.downPorts])
      unit(null, [{ key: `l${l.id}`, kind: 'link', cls: l.cls, name: l.path, node: l.child, group: [],
        x0: attX(l.childAtt), x1: attX(l.parentAtt),
        yc: 0, slot: 0, slots: st.length, ends: [l.childAtt, l.parentAtt], strips: st,
        fwd: l.up, rev: l.down, fwdPorts: l.upPorts, revPorts: l.downPorts, members: [], fwdMembers: [], revMembers: [] }], band)
    }
  }

  const visitNode = (id: number) => {
    const n = m.nodes[id]
    out.level = Math.max(out.level, n.depth)
    placedBuses.push(...n.buses)
    for (const g of tree.runs[id]) placeItem(g, `n${id}`)
    placeLinks(n.inlinks, `n${id}`)
  }

  /** A closed group of nodes in a band of its own, below everything before it (beside an
   * open sibling it could cover the sibling's bus boxes, which are not packed). */
  const placeClosed = (g: MGroup) => {
    out.seq.push({ open: `a${g.key}`, label: g.label, kind: 'agg' })
    placeAgg(g, `a${g.key}`)
    out.seq.push({ close: `a${g.key}` })
  }

  const placeItem = (g: MGroup, band: string) => {
    const one = g.members.length === 1 ? g.members[0] : null
    if (one && 'node' in one) {
      if (isOpen(g.key)) {
        out.seq.push({ open: g.key, label: g.label, kind: 'node' })
        visitNode(one.node)
        placeLinks(m.nodes[one.node].uplinks, g.key)
        out.seq.push({ close: g.key })
      } else placeClosed(g)
    } else if (one) placeBlock(one.block, band)
    else if (isOpen(g.key) && 'block' in g.members[0]) {
      // A split block group floats in its node's band like single blocks; a bracket marks it.
      const first = out.blocks.length
      const inner = out.brackets.length
      for (const p of g.parts) placeItem(p, band)
      const nested = out.brackets.slice(inner)
      out.brackets.push({ key: g.key, label: g.label, blocks: out.blocks.slice(first),
        level: nested.length ? 1 + Math.max(...nested.map((b) => b.level)) : 0, left: m.nodes[g.parent].depth === D })
    } else if (isOpen(g.key)) {
      out.seq.push({ open: g.key, label: g.label, kind: 'group' })
      for (const p of g.parts) placeItem(p, g.key)
      out.seq.push({ close: g.key })
    } else if ('node' in g.members[0]) placeClosed(g)
    else placeBlockGroup(g, band)
  }

  out.seq.push({ open: `n${m.root}`, label: m.nodes[m.root].name, kind: 'node' })
  visitNode(m.root)
  out.seq.push({ close: `n${m.root}` })
  const used = new Set(out.links.flatMap((l) => l.ends))
  for (const bus of placedBuses) {
    if (!visible[bus.cls]) continue
    const atts = bus.atts.filter((a) => used.has(a))
    if (!atts.length) continue
    out.buses.push({ x: busX.get(bus.id) ?? 0, label: bus.label, path: bus.path,
      cls: bus.cls, atts })
  }
  return out
}
