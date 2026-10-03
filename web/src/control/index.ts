// The tables of each Neutrino at a time t (views-design Section 4): scoreboard (invoke <=
// t < issue) and execution table (issue <= t < retire). Per Neutrino the task rows are
// sorted by invoke, in blocks of BLOCK rows with the largest retire of each block, so a
// query scans only the blocks that hold a task still in a table at t.
import type { Trace } from '../data/trace'

const BLOCK = 256

export interface Tables {
  scoreboard: number[]    // task rows, by invoke
  execution: number[]
}

export interface PendingDep {
  producer: number        // gid, -1 if no producer (a store wrote the range)
  remote: boolean
}

export class ControlIndex {
  private readonly rows: Int32Array[] = []        // per Neutrino: task rows by invoke
  private readonly blockMax: Float64Array[] = []  // per Neutrino and block: largest retire
  private readonly invoke: Float64Array
  private readonly issue: Float64Array
  private readonly retire: Float64Array
  private readonly depConsumer: Int32Array
  private readonly depProducer: Int32Array
  private readonly depResolved: Float64Array
  private readonly depRemote: Uint8Array
  private readonly gid: Int32Array
  /** Time to build the index (measured by the view). */
  buildMs = 0

  constructor(trace: Trace) {
    const c = trace.facts.tasks.cols
    this.invoke = c.invoke as Float64Array
    this.issue = c.issue as Float64Array
    this.retire = c.retire as Float64Array
    this.gid = c.gid as Int32Array
    const d = trace.facts.deps.cols
    this.depConsumer = d.consumer as Int32Array
    this.depProducer = d.producer as Int32Array
    this.depResolved = d.resolved as Float64Array
    this.depRemote = d.remote as Uint8Array
    const nu = c.nu as Int32Array
    const nNodes = trace.dims.nodes.length
    const count = new Int32Array(nNodes)
    for (let i = 0; i < nu.length; i++) if (nu[i] >= 0 && nu[i] < nNodes && this.invoke[i] === this.invoke[i]) count[nu[i]]++
    for (let n = 0; n < nNodes; n++) this.rows.push(new Int32Array(count[n]))
    const fill = new Int32Array(nNodes)
    for (let i = 0; i < nu.length; i++) {
      const n = nu[i]
      if (n >= 0 && n < nNodes && this.invoke[i] === this.invoke[i]) this.rows[n][fill[n]++] = i
    }
    for (let n = 0; n < nNodes; n++) {
      const r = this.rows[n]
      // gid order is invoke order in r2-sim; sort only if a dump breaks it.
      let sorted = true
      for (let k = 1; k < r.length && sorted; k++) if (this.invoke[r[k]] < this.invoke[r[k - 1]]) sorted = false
      if (!sorted) r.sort((x, y) => this.invoke[x] - this.invoke[y] || x - y)
      const max = new Float64Array(Math.ceil(r.length / BLOCK))
      for (let k = 0; k < r.length; k++) {
        const v = this.retire[r[k]]
        const e = v === v ? v : Infinity   // never retired: still in a table at the end
        const blk = (k / BLOCK) | 0
        if (e > max[blk]) max[blk] = e
      }
      this.blockMax.push(max)
    }
  }

  /** Tasks of a Neutrino in its scoreboard and its execution table at t. */
  at(nu: number, t: number): Tables {
    const r = this.rows[nu]
    const out: Tables = { scoreboard: [], execution: [] }
    if (!r) return out
    // Rows [0, hi) have invoke <= t.
    let lo = 0
    let hi = r.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (this.invoke[r[mid]] <= t) lo = mid + 1
      else hi = mid
    }
    const max = this.blockMax[nu]
    for (let b = 0; b * BLOCK < lo; b++) {
      if (max[b] <= t) continue
      const end = Math.min(lo, (b + 1) * BLOCK)
      for (let k = b * BLOCK; k < end; k++) {
        const i = r[k]
        const ret = this.retire[i]
        if (ret === ret && ret <= t) continue
        const iss = this.issue[i]
        if (iss === iss && iss <= t) out.execution.push(i)
        else out.scoreboard.push(i)
      }
    }
    return out
  }

  /** The dependencies of a task not resolved at t, with their producers. */
  pendingDeps(task: number, t: number): PendingDep[] {
    const g = this.gid[task]
    const c = this.depConsumer
    let lo = 0
    let hi = c.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (c[mid] < g) lo = mid + 1
      else hi = mid
    }
    const out: PendingDep[] = []
    for (let i = lo; i < c.length && c[i] === g; i++) {
      const r = this.depResolved[i]
      if (r === r && r <= t) continue
      out.push({ producer: this.depProducer[i], remote: this.depRemote[i] === 1 })
    }
    return out
  }

  /** Task row of a gid, or -1 (the task is not in the trace). */
  rowOf(gid: number): number {
    const a = this.gid
    let lo = 0
    let hi = a.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (a[mid] < gid) lo = mid + 1
      else hi = mid
    }
    return lo < a.length && a[lo] === gid ? lo : -1
  }
}
