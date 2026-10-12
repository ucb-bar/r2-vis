// The strip values of the block diagram, over a time range in n samples (0..1 of the 100 %
// line), as decided in views-design Section 2: tensor and vector utilization of the
// subtree, and the traffic of the node's own links per class.
import type { Trace } from '../data/trace'

import { recorded, recordedPart } from '../timeline/rows'

export type TrafficClass = 'global' | 'local' | 'control'
export const TRAFFIC_CLASSES: TrafficClass[] = ['global', 'local', 'control']

export class BlockMetrics {
  private readonly trace: Trace
  private readonly subtree: number[][]      // per node: the node and its descendants
  private readonly tensorRes: number[][]    // per node: tensor PE resources of the subtree
  private readonly vectorRes: number[][]    // per node: vector PE resources of the subtree
  private readonly ownLinks: Record<TrafficClass, number[][]>  // per class, per node: own links
  /** the recorded window of a windowed dump: averages are taken over their part inside it */
  readonly window: [number, number] | null

  constructor(trace: Trace) {
    this.trace = trace
    this.window = recorded(trace).window
    const nodes = trace.dims.nodes
    const children = new Map<number, number[]>()
    for (const n of nodes) {
      const p = n.parent as number | null
      if (p !== null) children.set(p, [...(children.get(p) ?? []), n.id as number])
    }
    const collect = (id: number): number[] => [id, ...(children.get(id) ?? []).flatMap(collect)]
    this.subtree = nodes.map((n) => collect(n.id as number))
    const res = trace.dims.resources
    const byNode = (pred: (r: (typeof res)[number]) => boolean) =>
      nodes.map((n) => res.filter((r) => r.node === n.id && pred(r)).map((r) => r.id as number))
    const tensorOwn = byNode((r) => r.kind === 'TensorOps' && r.role === 'pe')
    const vectorOwn = byNode((r) => r.kind === 'VectorOps' && r.role === 'pe')
    this.tensorRes = this.subtree.map((ids) => ids.flatMap((id) => tensorOwn[id]))
    this.vectorRes = this.subtree.map((ids) => ids.flatMap((id) => vectorOwn[id]))
    // A node's own links: the ports of its buses and the links of its fabric (links.node).
    const links = trace.dims.links
    const ownerOf = (r: (typeof res)[number]) => (r.role === 'link' ? links[r.link as number].node : r.node)
    const own = (cls: TrafficClass) => nodes.map((n) => res.filter((r) =>
      r.is_link === 1 && r.class === cls && ownerOf(r) === n.id).map((r) => r.id as number))
    this.ownLinks = { global: own('global'), local: own('local'), control: own('control') }
  }

  /** Tensor utilization: tensor ops of the subtree / tensor capacity of the subtree. */
  tensor(node: number, a: number, b: number, n: number, out: Float64Array): boolean {
    return this.ratio(this.tensorRes[node], (r) => this.rate(r), a, b, n, out)
  }

  /** Vector utilization: vector ops of the subtree / vector capacity of the subtree. */
  vector(node: number, a: number, b: number, n: number, out: Float64Array): boolean {
    return this.ratio(this.vectorRes[node], (r) => this.rate(r), a, b, n, out)
  }

  /** Traffic of one class: the node's own links of that class, sum of amounts / sum of
   * ceilings (channel-width weighted). */
  traffic(node: number, cls: TrafficClass, a: number, b: number, n: number, out: Float64Array): boolean {
    return this.ratio(this.ownLinks[cls][node], (r) => this.ceiling(r), a, b, n, out)
  }

  /** The classes that have links at the node (a class with none gets no strip). */
  classesAt(node: number): TrafficClass[] {
    return TRAFFIC_CLASSES.filter((c) => this.ownLinks[c][node].length > 0)
  }

  /** Compute utilization of a small box: the tensor utilization (no tensor arrays: the
   * vector utilization). */
  compute(node: number, a: number, b: number, n: number, out: Float64Array): boolean {
    return this.tensor(node, a, b, n, out) || this.vector(node, a, b, n, out)
  }

  /** Window average of compute (the color of a small box), over the recorded part; NaN
   * if none. */
  computeAverage(node: number, a: number, b: number): number {
    const r = recordedPart(this.window, a, b)
    const out = new Float64Array(1)
    return r && this.compute(node, r.a, r.b, 1, out) ? out[0] : NaN
  }

  /** Averages over the recorded part of [a, b): tensor, vector and per class traffic, the
   * ones the node has; null if [a, b) is outside the recording. */
  averages(node: number, from: number, to: number): { name: string; value: number }[] | null {
    const r = recordedPart(this.window, from, to)
    if (!r) return null
    const { a, b } = r
    const out = new Float64Array(1)
    const rows: { name: string; value: number }[] = []
    if (this.tensor(node, a, b, 1, out)) rows.push({ name: 'tensor', value: out[0] })
    if (this.vector(node, a, b, 1, out)) rows.push({ name: 'vector', value: out[0] })
    for (const c of this.classesAt(node)) if (this.traffic(node, c, a, b, 1, out)) rows.push({ name: c, value: out[0] })
    return rows
  }

  private rate(r: number): number {
    return (this.trace.dims.resources[r].rate as number | null) ?? 0
  }

  private ceiling(r: number): number {
    return (this.trace.dims.resources[r].ceiling as number | null) ?? 0
  }

  /** Sum of the amounts of `resources` over each sample / (sum of `scale` x sample span).
   * False if the resources have no capacity (no line). */
  private ratio(resources: number[], scale: (r: number) => number, a: number, b: number, n: number,
    out: Float64Array): boolean {
    const lv = this.trace.levels
    let capacity = 0
    for (const r of resources) capacity += scale(r)
    out.fill(0, 0, n)
    if (!(capacity > 0) || b <= a) return false
    const W = lv.width
    const count = lv.count
    const step = (b - a) / n
    for (const r of resources) {
      const row = lv.rowOf[r]
      if (row < 0) continue
      const o = row * (count + 1)
      const pre = lv.prefix
      const F = (t: number): number => {
        const u = (t - lv.origin) / W
        if (u <= 0) return pre[o]
        if (u >= count) return pre[o + count]
        const i = Math.floor(u)
        return pre[o + i] + (u - i) * (pre[o + i + 1] - pre[o + i])
      }
      let prev = F(a)
      for (let k = 0; k < n; k++) {
        const next = F(a + (k + 1) * step)
        out[k] += next - prev
        prev = next
      }
    }
    for (let k = 0; k < n; k++) out[k] /= capacity * step
    return true
  }
}
