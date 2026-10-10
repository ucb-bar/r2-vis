// Table pressure of the Neutrinos (views-design 6.3): occupancy / capacity of the eight
// tables, per Neutrino, at a time or over a range. The scoreboard ([invoke, issue)) and the
// execution table ([issue, retire)) come from the tasks; the six others from the entries
// table (trace-raw 4.7), loaded on first use.
import type { Table } from '../data/columns'
import { OccupancyIndex, type Occupancy } from '../data/occupancy'
import type { WorkerPool } from '../data/pool'
import type { Trace } from '../data/trace'
import { recorded } from '../timeline/rows'

export interface TableDef {
  id: number
  name: string
  cap: string         // nodes column of the capacity
}

/** The tables in display order; ids 2 to 7 are entries.table + 2. */
export const TABLES: TableDef[] = [
  { id: 0, name: 'scoreboard', cap: 'cap_scoreboard' },
  { id: 1, name: 'execution', cap: 'cap_execution' },
  { id: 2, name: 'pending', cap: 'cap_pending' },
  { id: 3, name: 'versions', cap: 'cap_versions' },
  { id: 4, name: 'inbound refs', cap: 'cap_inbound_refs' },
  { id: 5, name: 'inbound invokes', cap: 'cap_inbound_invokes' },
  { id: 6, name: 'outbound deps', cap: 'cap_outbound_deps' },
  { id: 7, name: 'outbound invokes', cap: 'cap_outbound_invokes' },
]
export const N_TABLES = TABLES.length

export const GROUPS = {
  all: [0, 1, 2, 3, 4, 5, 6, 7],
  lifetime: [2, 0, 1, 3],     // pending, scoreboard, execution, versions
  remote: [4, 5, 6, 7],       // inbound refs, inbound invokes, outbound deps, outbound invokes
} as const
export type GroupName = keyof typeof GROUPS

export type Metric = { kind: 'table'; table: number } | { kind: 'worst' | 'average'; group: GroupName }
export type Statistic = 'at' | 'average' | 'peak'

export interface TableValue {
  recorded: boolean
  cap: number | null
  /** occupancy: at the time, range average, range peak */
  at: number
  average: number
  peak: number
}

export class ControlData {
  readonly trace: Trace
  /** the entries table (null if the trace has none, or not loaded yet) */
  entries: Table | null = null
  readonly hasEntries: boolean
  private index: OccupancyIndex | null = null
  private readonly cache = new Map<number, number>()
  private cacheKey = ''
  private readonly caps: (number | null)[][]   // [node][table]
  private readonly tableRecorded: boolean[][]  // [node][table]

  constructor(trace: Trace) {
    this.trace = trace
    const rec = recorded(trace)
    const f = trace.manifest.source.filters
    const typeKept = !f?.types || f.types.includes('entries')
    this.hasEntries = trace.reader.has('entries') && typeKept
      && !(trace.manifest.source.absent_records ?? []).includes('entries')
    this.caps = trace.dims.nodes.map((n) => TABLES.map((t) => {
      const v = n[t.cap]
      return typeof v === 'number' ? v : null
    }))
    this.tableRecorded = trace.dims.nodes.map((_, i) => TABLES.map((t) =>
      rec.inTree[i] && (t.id < 2 ? rec.tasks : this.hasEntries)))
  }

  get ready(): boolean {
    return this.index !== null
  }

  /** Loads the entries (if any) and builds the occupancy series in a worker. */
  async load(pool: WorkerPool): Promise<void> {
    if (this.hasEntries) this.entries = await this.trace.reader.readColumns('entries', null)
    const nNodes = this.trace.dims.nodes.length
    const t = this.trace.facts.tasks.cols
    const nu = t.nu as Int32Array
    const invoke = t.invoke as Float64Array
    const issue = t.issue as Float64Array
    const retire = t.retire as Float64Array
    const nTasks = nu.length
    const e = this.entries?.cols
    const nEntries = e ? (e.nu as Int32Array).length : 0
    const total = 2 * nTasks + nEntries
    const series = new Int32Array(total)
    const start = new Float64Array(total)
    const end = new Float64Array(total)
    for (let i = 0; i < nTasks; i++) {
      // scoreboard [invoke, issue); execution [issue, retire)
      series[2 * i] = nu[i] * N_TABLES
      start[2 * i] = invoke[i]
      end[2 * i] = issue[i]
      series[2 * i + 1] = nu[i] * N_TABLES + 1
      start[2 * i + 1] = issue[i]
      end[2 * i + 1] = retire[i]
    }
    if (e) {
      const en = e.nu as Int32Array
      const et = e.table as Int8Array | Int32Array
      const es = e.start as Float64Array
      const ee = e.end as Float64Array
      for (let k = 0; k < nEntries; k++) {
        series[2 * nTasks + k] = en[k] * N_TABLES + et[k] + 2
        start[2 * nTasks + k] = es[k]
        end[2 * nTasks + k] = ee[k]
      }
    }
    const occ = await pool.compute<Occupancy>({ op: 'occupancy', args: [series, start, end, nNodes * N_TABLES] },
      [series.buffer, start.buffer, end.buffer])
    this.index = new OccupancyIndex(occ)
  }

  /** One table of one node: occupancy at t and over [a, b). */
  value(node: number, table: number, t: number, a: number, b: number): TableValue {
    const ix = this.index
    const s = node * N_TABLES + table
    const rec = this.tableRecorded[node][table]
    if (!ix || !rec) return { recorded: rec, cap: this.caps[node][table], at: 0, average: 0, peak: 0 }
    return { recorded: true, cap: this.caps[node][table], at: ix.at(s, t), average: ix.average(s, a, b), peak: ix.peak(s, a, b) }
  }

  /** One statistic of one table of one node; the range statistics are cached per range
   * (they do not change with the cursor). */
  stat(node: number, table: number, stat: Statistic, t: number, a: number, b: number): number {
    const ix = this.index as OccupancyIndex
    const s = node * N_TABLES + table
    if (stat === 'at') return ix.at(s, t)
    const key = `${a}|${b}`
    if (key !== this.cacheKey) { this.cache.clear(); this.cacheKey = key }
    const ck = s * 2 + (stat === 'peak' ? 1 : 0)
    let v = this.cache.get(ck)
    if (v === undefined) {
      v = stat === 'peak' ? ix.peak(s, a, b) : ix.average(s, a, b)
      this.cache.set(ck, v)
    }
    return v
  }

  /** The heat of a node: the pressure (0..1) of the metric and statistic, or null if no
   * table of the metric is recorded with a capacity. */
  heat(node: number, metric: Metric, stat: Statistic, t: number, a: number, b: number): number | null {
    if (!this.index) return null
    const tables = metric.kind === 'table' ? [metric.table] : GROUPS[metric.group]
    let worst = 0
    let sum = 0
    let n = 0
    for (const id of tables) {
      const cap = this.caps[node][id]
      if (!this.tableRecorded[node][id] || !cap) continue
      const p = this.stat(node, id, stat, t, a, b) / cap
      worst = Math.max(worst, p)
      sum += p
      n++
    }
    if (n === 0) return null
    return metric.kind === 'average' ? sum / n : worst
  }

  /** The entry rows (of the entries table) of a node's table present at t. */
  entriesAt(node: number, table: number, t: number): number[] {
    const e = this.entries?.cols
    if (!e || table < 2) return []
    const nu = e.nu as Int32Array
    const tb = e.table as Int8Array | Int32Array
    const start = e.start as Float64Array
    const end = e.end as Float64Array
    const code = table - 2
    // rows are sorted by (nu, table, start): the segment of (node, code)
    const key = (i: number) => nu[i] * 8 + tb[i]
    const want = node * 8 + code
    let lo = 0
    let hi = nu.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (key(mid) < want) lo = mid + 1
      else hi = mid
    }
    const out: number[] = []
    for (let i = lo; i < nu.length && key(i) === want && start[i] <= t; i++) {
      if (!(end[i] <= t)) out.push(i)   // end NaN: still present
    }
    return out
  }
}
