// Utilization per pixel column of a resource row, in units per cycle: from the bin levels
// (prefix sums: exact averages at bin resolution; the max pyramid gives the peak bin in a
// pixel), or from the charges when a pixel is narrower than one bin.
import type { ChargeGroup } from '../data/charges'
import type { BinLevels, FabricLevels, LaneIndex } from '../data/derive'

/** Average and peak (largest bin average) per pixel; peak only when a pixel spans more
 * than one bin. */
export function sampleBins(lv: BinLevels, row: number, t0: number, cpp: number, n: number,
  avg: Float64Array, peak: Float64Array): boolean {
  const W = lv.width
  const count = lv.count
  const pre = lv.prefix
  const o = row * (count + 1)
  const F = (t: number): number => {
    const u = t / W
    if (u <= 0) return pre[o]
    if (u >= count) return pre[o + count]
    const i = Math.floor(u)
    return pre[o + i] + (u - i) * (pre[o + i + 1] - pre[o + i])
  }
  let prev = F(t0)
  for (let p = 0; p < n; p++) {
    const next = F(t0 + (p + 1) * cpp)
    avg[p] = (next - prev) / cpp
    prev = next
  }
  if (cpp <= W) return false
  const k = Math.min(lv.max.length - 1, Math.floor(Math.log(cpp / W) / Math.log(4)))
  const bw = W * 4 ** k
  const arr = lv.max[k]
  const m = Math.ceil(count / 4 ** k)
  const base = row * m
  for (let p = 0; p < n; p++) {
    const ta = t0 + p * cpp
    const b0 = Math.max(0, Math.floor(ta / bw))
    const b1 = Math.min(m, Math.ceil((ta + cpp) / bw))
    let v = 0
    for (let b = b0; b < b1; b++) if (arr[base + b] > v) v = arr[base + b]
    peak[p] = v / W
  }
  return true
}

/** Per pixel, the member of a fabric series' largest bin (the argmax port), -1 if none. */
export function sampleArg(fl: FabricLevels, row: number, t0: number, cpp: number, n: number): Int32Array {
  const out = new Int32Array(n).fill(-1)
  const W = fl.width
  const count = fl.count
  const k = cpp <= W ? 0 : Math.min(fl.max.length - 1, Math.floor(Math.log(cpp / W) / Math.log(4)))
  const bw = W * 4 ** k
  const arr = fl.max[k]
  const arg = fl.arg[k]
  const m = Math.ceil(count / 4 ** k)
  const base = row * m
  for (let p = 0; p < n; p++) {
    const ta = t0 + p * cpp
    const b0 = Math.max(0, Math.floor(ta / bw))
    const b1 = Math.min(m, Math.max(b0 + 1, Math.ceil((ta + cpp) / bw)))
    let v = 0
    for (let b = b0; b < b1; b++) if (arr[base + b] > v) { v = arr[base + b]; out[p] = arg[base + b] }
  }
  return out
}

/** Exact average per pixel from the charges of the loaded groups (all groups that overlap
 * the window must be given); a zero-cycle charge counts over one cycle. `diff` is scratch
 * space of n + 1 entries. */
export function sampleCharges(groups: ChargeGroup[], resource: number, t0: number, cpp: number,
  n: number, avg: Float64Array, diff: Float64Array): void {
  avg.fill(0, 0, n)
  diff.fill(0, 0, n + 1)
  const t1 = t0 + n * cpp
  for (const g of groups) {
    const from = g.from[resource]
    const to = g.to[resource]
    if (to <= from) continue
    const start = g.table.cols.start as Float64Array
    const end = g.table.cols.end as Float64Array
    const amount = g.table.cols.amount as Float64Array
    // first charge that can reach t0
    let lo = from
    let hi = to
    const tmin = t0 - g.maxSpan[resource]
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (start[mid] < tmin) lo = mid + 1
      else hi = mid
    }
    for (let i = lo; i < to; i++) {
      const s = start[i]
      if (s >= t1) break
      // A zero-cycle charge is drawn over one cycle (its amount stays the same).
      const e = end[i] > s ? end[i] : s + 1
      const a = amount[i]
      if (e <= t0) continue
      const perPx = (a / (e - s)) * cpp
      const x0 = Math.max(0, (s - t0) / cpp)
      const x1 = Math.min(n, (e - t0) / cpp)
      const p0 = Math.floor(x0)
      const p1 = Math.floor(x1)
      if (p0 === p1) {
        if (p0 < n) avg[p0] += perPx * (x1 - x0)
        continue
      }
      avg[p0] += perPx * (p0 + 1 - x0)
      if (p1 < n) avg[p1] += perPx * (x1 - p1)
      if (p1 > p0 + 1) {
        diff[p0 + 1] += perPx
        diff[p1] -= perPx
      }
    }
  }
  let run = 0
  for (let p = 0; p < n; p++) {
    run += diff[p]
    avg[p] = (avg[p] + run) / cpp
  }
}

/** Centered moving average of src[m .. m + n) over w pixels (1 = copy); src holds m extra
 * samples on each side, so the edges of the view are averaged like the middle. */
export function smooth(src: Float64Array, m: number, n: number, w: number, out: Float64Array): void {
  if (w <= 1) {
    for (let p = 0; p < n; p++) out[p] = src[m + p]
    return
  }
  const left = Math.floor((w - 1) / 2)
  const right = w - 1 - left
  let sum = 0
  for (let k = m - left; k <= m + right; k++) sum += src[k]
  for (let p = 0; p < n; p++) {
    out[p] = sum / w
    sum += src[m + p + right + 1] - src[m + p - left]
  }
}

/** Amount of a resource in [a, b), from the charges of the given groups (a zero-cycle
 * charge counts if its start is in the range). */
export function chargesAmount(groups: ChargeGroup[], resource: number, a: number, b: number): number {
  let sum = 0
  for (const g of groups) {
    const from = g.from[resource]
    const to = g.to[resource]
    if (to <= from) continue
    const start = g.table.cols.start as Float64Array
    const end = g.table.cols.end as Float64Array
    const amount = g.table.cols.amount as Float64Array
    let lo = from
    let hi = to
    const tmin = a - g.maxSpan[resource]
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (start[mid] < tmin) lo = mid + 1
      else hi = mid
    }
    for (let i = lo; i < to && start[i] < b; i++) {
      const s = start[i]
      const e = end[i]
      if (e === s) {
        if (s >= a) sum += amount[i]
        continue
      }
      const ov = Math.min(e, b) - Math.max(s, a)
      if (ov > 0) sum += (amount[i] * ov) / (e - s)
    }
  }
  return sum
}

/** Amount of a resource in [a, b): whole bins from the prefix sums; the partial bins at
 * the two ends from `edge` (the charges, when loaded), else interpolated in the bin.
 * Returns the amount and whether it is exact. */
export function rangeAmount(lv: BinLevels, row: number, a: number, b: number,
  edge: (x: number, y: number) => number | null): { amount: number; exact: boolean } {
  const W = lv.width
  const count = lv.count
  const pre = lv.prefix
  const o = row * (count + 1)
  const at = (bin: number) => pre[o + Math.max(0, Math.min(count, bin))]
  const binOf = (t: number) => Math.max(0, Math.min(count, Math.floor(t / W)))
  const ia = binOf(a)
  const ib = binOf(b)
  const frac = (bin: number, lo: number, hi: number) => {
    const bs = bin * W
    const amt = at(bin + 1) - at(bin)
    return amt * (Math.max(0, Math.min(hi, bs + W) - Math.max(lo, bs)) / W)
  }
  if (ia === ib) {
    const e = edge(a, b)
    if (e !== null) return { amount: e, exact: true }
    return { amount: frac(ia, a, b), exact: false }
  }
  let amount = at(ib) - at(ia + 1)  // whole bins (ia, ib)
  let exact = true
  if (a === ia * W) amount += at(ia + 1) - at(ia)
  else {
    const e = edge(a, (ia + 1) * W)
    if (e !== null) amount += e
    else { amount += frac(ia, a, b); exact = false }
  }
  if (b !== ib * W) {
    const e = edge(ib * W, b)
    if (e !== null) amount += e
    else { amount += frac(ib, a, b); exact = false }
  }
  return { amount, exact }
}

/** Busy fraction of a lane per pixel: the average number of active tasks over the lane's
 * depth. B(t) = busy time of the tasks issued before t, differenced per pixel (exact when
 * tasks do not overlap; a task that started earlier counts in its issue's pixels). */
export function laneBusy(idx: LaneIndex, lane: number, t0: number, cpp: number, n: number,
  out: Float64Array): void {
  const a = idx.start[lane]
  const b = idx.start[lane + 1]
  const B = (t: number): number => {
    let lo = a
    let hi = b
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (idx.issue[mid] <= t) lo = mid + 1
      else hi = mid
    }
    if (lo === a) return 0
    const p = lo - 1
    return idx.busyPrefix[p] + Math.min(Math.max(0, t - idx.issue[p]), idx.end[p] - idx.issue[p])
  }
  let prev = B(t0)
  for (let p = 0; p < n; p++) {
    const next = B(t0 + (p + 1) * cpp)
    out[p] = Math.min(1, (next - prev) / (cpp * idx.depth[lane]))
    prev = next
  }
}
