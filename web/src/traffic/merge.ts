// The merge tree of the traffic view (views-design 6.6): the children of a node (its child
// nodes, then its own blocks) in runs of adjacent siblings of the same kind (the same name
// stem: sm0..sm3, hbm.b0..b63); each run
// merged pairwise (sm0-1, sm2-3), then the pairs (sm0-3), an odd member joining the last
// group. The drawn layout is a cut of this tree (see levelCuts in the renderer).
import { attachmentExtras, mergedName, type Dirs, type LinkClass, type TBlock, type TrafficModel } from './model'

export type Member = { node: number } | { block: TBlock }

export interface MGroup {
  /** `n<id>` for one node, `b<path>` for one block, `g<...>` for a merged group */
  key: string
  /** the node whose children it groups */
  parent: number
  members: Member[]
  /** its parts (two or three); empty for one member */
  parts: MGroup[]
  label: string
}

/** The links of a group, per class: inside it (its members' subtrees: bus ports and the
 * links below the members) and leaving it (the members' links to the parent, or a block
 * group's ports on the parent's buses), with the parent-side attachments they end on. */
export interface GroupLinks {
  inner: Record<LinkClass, Dirs>
  cross: Record<LinkClass, Dirs>
  ends: Record<LinkClass, number[]>
}

const emptyDirs = (): Record<LinkClass, Dirs> =>
  ({ global: { fwd: [], rev: [] }, local: { fwd: [], rev: [] }, control: { fwd: [], rev: [] } })

/** The name stem: the name without its trailing number (sm3 -> sm, hbm.b12 -> hbm.b). */
const stem = (name: string) => name.replace(/\d+$/, '')

export class MergeTree {
  readonly m: TrafficModel
  /** per node: the roots of its runs, in order */
  readonly runs: MGroup[][]
  /** the key of the group (or open node `n<id>`) each key is a part of */
  readonly parentOf = new Map<string, string>()
  private readonly links = new Map<string, GroupLinks>()

  constructor(m: TrafficModel) {
    this.m = m
    this.runs = m.nodes.map((n) => {
      const leaves: { kind: string; g: MGroup }[] = [
        ...n.children.map((c) => ({ kind: `n:${stem(m.nodes[c].name)}`,
          g: { key: `n${c}`, parent: n.id, members: [{ node: c }], parts: [], label: m.nodes[c].name } })),
        ...n.blocks.map((b) => ({ kind: `b:${stem(b.label)}`,
          g: { key: `b${b.key}`, parent: n.id, members: [{ block: b }], parts: [], label: b.label } })),
      ]
      const runs: MGroup[] = []
      for (let i = 0; i < leaves.length;) {
        let j = i + 1
        while (j < leaves.length && leaves[j].kind === leaves[i].kind) j++
        runs.push(this.merge(leaves.slice(i, j).map((x) => x.g)))
        i = j
      }
      return runs
    })
    const up = (g: MGroup, parent: string) => {
      this.parentOf.set(g.key, parent)
      for (const p of g.parts) up(p, g.key)
    }
    this.runs.forEach((runs, id) => runs.forEach((g) => up(g, `n${id}`)))
  }

  /** Pairwise merging of a run: groups of two, the last of three when one is left. */
  private merge(leaves: MGroup[]): MGroup {
    let level = leaves
    while (level.length > 1) {
      const next: MGroup[] = []
      for (let i = 0; i < level.length;) {
        const take = level.length - i === 3 ? 3 : 2
        const parts = level.slice(i, i + take)
        const members = parts.flatMap((p) => p.members)
        next.push({ key: `g${parts[0].key}:${members.length}`, parent: parts[0].parent, members, parts,
          label: mergedName(parts.flatMap((p) => p.members.map((x) => ('node' in x ? this.m.nodes[x.node].name : x.block.label)))) })
        i += take
      }
      level = next
    }
    return level[0]
  }

  /** The links inside and leaving a group (or one collapsed node). */
  groupLinks(g: MGroup): GroupLinks {
    let out = this.links.get(g.key)
    if (out) return out
    const m = this.m
    const d = m.trace.dims
    out = { inner: emptyDirs(), cross: emptyDirs(), ends: { global: [], local: [], control: [] } }
    const parent = m.nodes[g.parent]
    const busCls = (bus: number) => parent.buses.find((b) => b.id === bus)?.cls
    const visit = (id: number, top: boolean) => {
      const n = m.nodes[id]
      for (const bus of n.buses) {
        for (const att of bus.atts) {
          const a = d.attachments[att]
          const x = attachmentExtras(m.trace, att)
          for (const r of [a.in_resource, ...x.fwd]) if (r !== null) out!.inner[bus.cls].fwd.push(r as number)
          for (const r of [a.out_resource, ...x.rev]) if (r !== null) out!.inner[bus.cls].rev.push(r as number)
        }
      }
      for (const l of n.inlinks) {
        out!.inner[l.cls].fwd.push(l.up, ...l.upPorts)
        out!.inner[l.cls].rev.push(l.down, ...l.downPorts)
      }
      for (const l of n.uplinks) {
        const to = top ? out!.cross : out!.inner
        to[l.cls].fwd.push(l.up, ...l.upPorts)
        to[l.cls].rev.push(l.down, ...l.downPorts)
        if (top) out!.ends[l.cls].push(l.parentAtt)
      }
      for (const c of n.children) visit(c, false)
    }
    for (const x of g.members) {
      if ('node' in x) visit(x.node, true)
      else {
        for (const att of x.block.atts) {
          const a = d.attachments[att]
          const cls = busCls(a.bus as number)
          if (!cls) continue
          const x = attachmentExtras(m.trace, att)
          for (const r of [a.in_resource, ...x.fwd]) if (r !== null) out.cross[cls].fwd.push(r as number)
          for (const r of [a.out_resource, ...x.rev]) if (r !== null) out.cross[cls].rev.push(r as number)
          out.ends[cls].push(att)
        }
      }
    }
    this.links.set(g.key, out)
    return out
  }

  /** The member nodes of a group. */
  static nodesOf(g: MGroup): number[] {
    return g.members.flatMap((x) => ('node' in x ? [x.node] : []))
  }
}
