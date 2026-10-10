// Charges row groups on demand (trace-format Section 8): the groups of a time window,
// decoded in the worker pool and kept in an LRU cache bounded by bytes.
import type { Column, Table } from './columns'
import type { ChargeBlock } from './manifest'
import type { Trace } from './trace'

export interface ChargeGroup {
  block: ChargeBlock
  table: Table
  bytes: number
  /** Per resource id: the rows [from[r], to[r]) of that resource (rows are sorted by
   * resource, then start), and the longest charge of the resource in this group. */
  from: Int32Array
  to: Int32Array
  maxSpan: Float64Array
}

const RECENT_MS = 1000

export class ChargeCache {
  private readonly groups = new Map<number, ChargeGroup>()  // insertion order = LRU order
  private readonly inflight = new Map<number, Promise<ChargeGroup>>()
  private bytes = 0
  private readonly trace: Trace
  private readonly limit: number
  /** Called when a group finishes loading (the timeline redraws). */
  onLoad: (() => void) | null = null
  private readonly listeners = new Set<() => void>()
  /** per group: when a view last asked for it (performance.now) */
  private readonly used = new Map<number, number>()

  constructor(trace: Trace, limitBytes = 512 * 1024 * 1024) {
    this.trace = trace
    this.limit = limitBytes
  }

  /** Row groups that hold charges overlapping [a, b). */
  groupsFor(a: number, b: number): ChargeBlock[] {
    return this.trace.manifest.charge_blocks.filter((g) => g.t0 < b && g.max_end > a)
  }

  /** A decoded group if it is cached (and marks it as recently used). */
  peek(group: number): ChargeGroup | undefined {
    this.used.set(group, performance.now())
    const g = this.groups.get(group)
    if (g) {
      this.groups.delete(group)
      this.groups.set(group, g)
    }
    return g
  }

  get(block: ChargeBlock): Promise<ChargeGroup> {
    this.used.set(block.group, performance.now())
    const hit = this.peek(block.group)
    if (hit) return Promise.resolve(hit)
    let p = this.inflight.get(block.group)
    if (!p) {
      p = this.trace.reader.readChargeGroup(block.group, this.trace.dims.resources.length).then((cols) => {
        const g = toGroup(block, cols)
        this.inflight.delete(block.group)
        this.groups.set(block.group, g)
        this.bytes += g.bytes
        this.evict()
        this.onLoad?.()
        for (const cb of this.listeners) cb()
        return g
      })
      this.inflight.set(block.group, p)
    }
    return p
  }

  /** Other views: called when a group finishes loading. Returns the unsubscribe. */
  subscribe(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => { this.listeners.delete(cb) }
  }

  /** Drops the least recently used groups over the limit, except the groups a view asked
   * for within the last second: one drawing can need more than the limit (the two ends of
   * a range in two large groups), and evicting one of them would load it again on the next
   * frame, which would evict the other, and so on. */
  private evict(): void {
    const recent = performance.now() - RECENT_MS
    for (const [key, g] of this.groups) {
      if (this.bytes <= this.limit || this.groups.size <= 1) break
      if ((this.used.get(key) ?? 0) > recent) continue
      this.groups.delete(key)
      this.bytes -= g.bytes
    }
  }
}

function toGroup(block: ChargeBlock, cols: Record<string, Column>): ChargeGroup {
  const { __from, __to, __maxSpan, ...data } = cols
  const table: Table = { rows: (data.start as Float64Array).length, cols: data }
  const bytes = Object.values(cols).reduce((a, c) => a + ('codes' in c ? c.codes.byteLength : c.byteLength), 0)
  return { block, table, bytes, from: __from as Int32Array, to: __to as Int32Array, maxSpan: __maxSpan as Float64Array }
}
