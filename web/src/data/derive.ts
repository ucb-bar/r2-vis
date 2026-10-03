// Derived structures built in a worker at load (trace-format Section 8): bin levels with
// prefix sums for utilization lines, and the per-lane task index for the lanes.

export interface BinLevels {
  width: number            // cycles per level-0 bin
  count: number            // level-0 bins per resource
  resources: Int32Array    // resource ids that have bins, ascending
  rowOf: Int32Array        // resource id -> row in the arrays below, -1 if none
  prefix: Float64Array     // per row: count + 1 prefix sums of the amount per bin (dirs summed)
  max: Float32Array[]      // level k: per row, the largest level-0 bin amount in 4^k bins
  /** The MAX series of the fabric nodes, if requested: one row per fabric group. */
  fabric?: FabricLevels
}

/** Per fabric group and bin: the largest fraction of ceiling over its members, times the
 * bin width (so that sampleBins gives fractions). `arg` is the member of each `max` entry. */
export interface FabricLevels extends BinLevels {
  arg: Int32Array[]
}

/** Fabric groups for buildLevels: group g has members[start[g], start[g + 1]);
 * ceiling per resource id. */
export interface FabricGroupArgs {
  start: Int32Array
  members: Int32Array
  ceiling: Float64Array
}

export function buildLevels(resource: Int32Array, bin: Int32Array, amount: Float32Array,
  nResources: number, count: number, width: number, groups?: FabricGroupArgs): BinLevels {
  const rowOf = new Int32Array(nResources).fill(-1)
  const ids: number[] = []
  for (let i = 0; i < resource.length; i++) {
    const r = resource[i]
    if (rowOf[r] < 0) { rowOf[r] = ids.length; ids.push(r) }
  }
  // Rows in resource id order.
  ids.sort((a, b) => a - b)
  ids.forEach((r, row) => { rowOf[r] = row })
  const rows = ids.length
  const base = new Float32Array(rows * count)
  for (let i = 0; i < resource.length; i++) base[rowOf[resource[i]] * count + bin[i]] += amount[i]
  const prefix = new Float64Array(rows * (count + 1))
  for (let r = 0; r < rows; r++) {
    let acc = 0
    const o = r * (count + 1)
    for (let b = 0; b < count; b++) {
      prefix[o + b] = acc
      acc += base[r * count + b]
    }
    prefix[o + count] = acc
  }
  const max: Float32Array[] = [base]
  let n = count
  while (n > 1) {
    const m = Math.ceil(n / 4)
    const prev = max[max.length - 1]
    const next = new Float32Array(rows * m)
    for (let r = 0; r < rows; r++) {
      for (let j = 0; j < m; j++) {
        let v = 0
        for (let k = 4 * j; k < Math.min(n, 4 * j + 4); k++) v = Math.max(v, prev[r * n + k])
        next[r * m + j] = v
      }
    }
    max.push(next)
    n = m
  }
  const levels: BinLevels = { width, count, resources: Int32Array.from(ids), rowOf, prefix, max }
  if (groups) levels.fabric = buildFabricLevels(levels, groups)
  return levels
}

function buildFabricLevels(lv: BinLevels, g: FabricGroupArgs): FabricLevels {
  const { count, width } = lv
  const rows = g.start.length - 1
  const base = new Float32Array(rows * count)
  const arg0 = new Int32Array(rows * count).fill(-1)
  const src = lv.max[0]
  for (let f = 0; f < rows; f++) {
    for (let k = g.start[f]; k < g.start[f + 1]; k++) {
      const r = g.members[k]
      const row = lv.rowOf[r]
      if (row < 0) continue
      // The bin amount over (bin width x ceiling) is the fraction; times the bin width.
      const scale = 1 / g.ceiling[r]
      for (let b = 0; b < count; b++) {
        const v = src[row * count + b] * scale
        if (v > base[f * count + b]) { base[f * count + b] = v; arg0[f * count + b] = r }
      }
    }
  }
  const prefix = new Float64Array(rows * (count + 1))
  for (let f = 0; f < rows; f++) {
    let acc = 0
    const o = f * (count + 1)
    for (let b = 0; b < count; b++) {
      prefix[o + b] = acc
      acc += base[f * count + b]
    }
    prefix[o + count] = acc
  }
  const max: Float32Array[] = [base]
  const arg: Int32Array[] = [arg0]
  let n = count
  while (n > 1) {
    const m = Math.ceil(n / 4)
    const prev = max[max.length - 1]
    const prevArg = arg[arg.length - 1]
    const next = new Float32Array(rows * m)
    const nextArg = new Int32Array(rows * m).fill(-1)
    for (let f = 0; f < rows; f++) {
      for (let j = 0; j < m; j++) {
        for (let k = 4 * j; k < Math.min(n, 4 * j + 4); k++) {
          if (prev[f * n + k] > next[f * m + j]) { next[f * m + j] = prev[f * n + k]; nextArg[f * m + j] = prevArg[f * n + k] }
        }
      }
    }
    max.push(next)
    arg.push(nextArg)
    n = m
  }
  return { width, count, resources: new Int32Array(0), rowOf: new Int32Array(0), prefix, max, arg }
}

export interface LaneIndex {
  start: Int32Array        // per lane: first position in `order`; lane l is [start[l], start[l+1])
  order: Int32Array        // task row indices, by lane then issue
  issue: Float64Array      // issue per position
  /** occupancy end per position: the last chunk end, or complete for a task without
   * chunks (end of run if never completed). Stacking, depth and busy use [issue, end). */
  end: Float64Array
  complete: Float64Array   // complete per position (the completion tail is [end, complete))
  chunkFirst: Int32Array   // per task row: its first chunk row (chunks are sorted by gid)
  busyPrefix: Float64Array // per position: sum of (end - issue) of the earlier positions of its lane
  maxEnd: Float64Array     // per position: largest end of the earlier and this position of its lane
  sub: Uint8Array          // per position: sub-row (overlapping tasks stack)
  taskSub: Uint8Array      // per task row: sub-row (255 if the task is not in a lane)
  depth: Int32Array        // per lane: sub-rows = the largest number of tasks active at once (capped)
}

/** At most this many sub-rows per lane; tasks beyond it share the last one. */
export const MAX_SUBROWS = 32

/** Tasks that were issued, grouped by lane and sorted by issue, with their occupancy
 * [issue, last chunk end) (or [issue, complete) without chunks) and sub-rows. */
export function buildLaneIndex(lane: Int32Array, issue: Float64Array, complete: Float64Array,
  gid: Int32Array, nChunks: Int32Array, chunkGid: Int32Array, chunkEnd: Float64Array,
  nLanes: number, endTime: number): LaneIndex {
  const n = lane.length
  // Chunks of task t: [chunkFirst[t], chunkFirst[t] + nChunks[t]) (lookup by gid, so that
  // chunks without a task row in a partial dump do not shift the ranges).
  const chunkFirst = new Int32Array(n)
  const occEnd = new Float64Array(n)
  let c = 0
  for (let t = 0; t < n; t++) {
    while (c < chunkGid.length && chunkGid[c] < gid[t]) c++
    chunkFirst[t] = c
    const cmp = complete[t] === complete[t] ? complete[t] : endTime
    let last = -Infinity
    for (let k = c; k < c + nChunks[t] && k < chunkEnd.length; k++) last = Math.max(last, chunkEnd[k])
    occEnd[t] = nChunks[t] > 0 && last > -Infinity ? Math.min(last, cmp) : cmp
  }
  const counts = new Int32Array(nLanes + 1)
  for (let i = 0; i < n; i++) if (issue[i] === issue[i] && lane[i] >= 0) counts[lane[i] + 1]++
  const start = new Int32Array(nLanes + 1)
  for (let l = 0; l < nLanes; l++) start[l + 1] = start[l] + counts[l + 1]
  const total = start[nLanes]
  const order = new Int32Array(total)
  const fill = start.slice(0, nLanes)
  for (let i = 0; i < n; i++) if (issue[i] === issue[i] && lane[i] >= 0) order[fill[lane[i]]++] = i
  for (let l = 0; l < nLanes; l++) sortByIssue(order, start[l], start[l + 1], issue)
  const iss = new Float64Array(total)
  const end = new Float64Array(total)
  const cmpl = new Float64Array(total)
  const busyPrefix = new Float64Array(total)
  const maxEnd = new Float64Array(total)
  const sub = new Uint8Array(total)
  const taskSub = new Uint8Array(n).fill(255)
  const depth = new Int32Array(nLanes)
  const slotEnd = new Float64Array(MAX_SUBROWS)
  for (let l = 0; l < nLanes; l++) {
    let busy = 0
    let mx = -Infinity
    let used = 0
    for (let p = start[l]; p < start[l + 1]; p++) {
      const t = order[p]
      const e = occEnd[t]
      iss[p] = issue[t]
      end[p] = e
      cmpl[p] = complete[t] === complete[t] ? complete[t] : endTime
      busyPrefix[p] = busy
      busy += e - issue[t]
      mx = Math.max(mx, e)
      maxEnd[p] = mx
      // The lowest sub-row that is free at the issue (free after the previous complete).
      let s = 0
      while (s < used && slotEnd[s] > issue[t]) s++
      if (s === used) {
        if (used < MAX_SUBROWS) used++
        else s = used - 1
      }
      slotEnd[s] = Math.max(slotEnd[s], e)
      sub[p] = s
      taskSub[t] = s
    }
    depth[l] = Math.max(1, used)
    slotEnd.fill(0, 0, used)
  }
  return { start, order, issue: iss, end, complete: cmpl, chunkFirst, busyPrefix, maxEnd, sub, taskSub, depth }
}

/** Sorts order[a..b) by issue (stable for equal issue). Packs issue and the local position
 * into one Float64 key when it is exact, else uses a comparator. */
function sortByIssue(order: Int32Array, a: number, b: number, issue: Float64Array): void {
  const n = b - a
  if (n < 2) return
  const scale = 2 ** Math.ceil(Math.log2(n + 1))
  let maxIssue = 0
  for (let p = a; p < b; p++) maxIssue = Math.max(maxIssue, issue[order[p]])
  if (maxIssue * scale < 2 ** 53) {
    const keys = new Float64Array(n)
    for (let p = 0; p < n; p++) keys[p] = issue[order[a + p]] * scale + p
    keys.sort()
    const copy = order.slice(a, b)
    for (let p = 0; p < n; p++) order[a + p] = copy[keys[p] % scale]
  } else {
    const part = Array.from(order.subarray(a, b))
    part.sort((x, y) => issue[x] - issue[y] || x - y)
    order.set(part, a)
  }
}

export interface DepsByProducer {
  start: Int32Array   // per producer gid: deps rows [order[start[g]], ...) up to start[g + 1]
  order: Int32Array   // deps row indices grouped by producer gid
}

/** The deps rows grouped by producer (a counting sort by gid); NULL producers are left out. */
export function buildDepsByProducer(producer: Int32Array, maxGid: number): DepsByProducer {
  const start = new Int32Array(maxGid + 2)
  for (let i = 0; i < producer.length; i++) {
    const g = producer[i]
    if (g >= 0 && g <= maxGid) start[g + 1]++
  }
  for (let g = 0; g <= maxGid; g++) start[g + 1] += start[g]
  const fill = start.slice(0, maxGid + 1)
  const order = new Int32Array(start[maxGid + 1])
  for (let i = 0; i < producer.length; i++) {
    const g = producer[i]
    if (g >= 0 && g <= maxGid) order[fill[g]++] = i
  }
  return { start, order }
}
