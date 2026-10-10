// Occupancy of the Neutrino tables over time (views-design 6.3): per series (a Neutrino and
// a table) the step function "entries present", from intervals [start, end) (end NaN: open
// until the end of the run). Built in a worker; a query is a binary search: the occupancy
// at t, the time average over [a, b) (from the cumulative area) and the peak over [a, b)
// (from block maxima of BLOCK events).

export const BLOCK = 64

export interface Occupancy {
  /** series s has events [offsets[s], offsets[s + 1]) */
  offsets: Int32Array
  /** event times, ascending per series (at one time, frees come before creations) */
  times: Float64Array
  /** occupancy after the event */
  level: Int32Array
  /** integral of the occupancy from 0 to the event's time */
  area: Float64Array
  /** largest level of each block of BLOCK events (global event index / BLOCK) */
  blockMax: Int32Array
}

/** Builds the series from intervals: series[i] in [0, nSeries), start[i], end[i]. */
export function buildOccupancy(series: Int32Array, start: Float64Array, end: Float64Array,
  nSeries: number): Occupancy {
  const count = new Int32Array(nSeries + 1)
  for (let i = 0; i < series.length; i++) {
    if (start[i] !== start[i]) continue
    count[series[i] + 1] += end[i] === end[i] ? 2 : 1
  }
  const offsets = new Int32Array(nSeries + 1)
  for (let s = 0; s < nSeries; s++) offsets[s + 1] = offsets[s] + count[s + 1]
  // Events coded as 2 t (a free) or 2 t + 1 (a creation): a numeric sort puts the frees of
  // a cycle before its creations, so an entry is present over [start, end).
  const coded = new Float64Array(offsets[nSeries])
  const fill = offsets.slice(0, nSeries)
  for (let i = 0; i < series.length; i++) {
    if (start[i] !== start[i]) continue
    const s = series[i]
    coded[fill[s]++] = 2 * start[i] + 1
    if (end[i] === end[i]) coded[fill[s]++] = 2 * end[i]
  }
  const times = new Float64Array(coded.length)
  const level = new Int32Array(coded.length)
  const area = new Float64Array(coded.length)
  for (let s = 0; s < nSeries; s++) {
    const seg = coded.subarray(offsets[s], offsets[s + 1])
    seg.sort()
    let lv = 0
    let acc = 0
    let prevT = 0
    for (let k = 0; k < seg.length; k++) {
      const v = seg[k]
      const t = Math.floor(v / 2)
      acc += lv * (t - prevT)
      prevT = t
      lv += v - 2 * t === 1 ? 1 : -1
      const i = offsets[s] + k
      times[i] = t
      level[i] = lv
      area[i] = acc
    }
  }
  const blockMax = new Int32Array(Math.ceil(level.length / BLOCK))
  for (let i = 0; i < level.length; i++) {
    const b = (i / BLOCK) | 0
    if (level[i] > blockMax[b]) blockMax[b] = level[i]
  }
  return { offsets, times, level, area, blockMax }
}

/** Queries on an Occupancy. */
export class OccupancyIndex {
  readonly occ: Occupancy

  constructor(occ: Occupancy) {
    this.occ = occ
  }

  /** Index of the last event of series s at or before t, or -1. */
  private last(s: number, t: number): number {
    const { offsets, times } = this.occ
    let lo = offsets[s]
    let hi = offsets[s + 1]
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (times[mid] <= t) lo = mid + 1
      else hi = mid
    }
    return lo - 1 >= this.occ.offsets[s] ? lo - 1 : -1
  }

  /** Occupancy at t. */
  at(s: number, t: number): number {
    const i = this.last(s, t)
    return i < 0 ? 0 : this.occ.level[i]
  }

  private areaTo(s: number, t: number): number {
    const i = this.last(s, t)
    if (i < 0) return 0
    return this.occ.area[i] + this.occ.level[i] * (t - this.occ.times[i])
  }

  /** Time average of the occupancy over [a, b). */
  average(s: number, a: number, b: number): number {
    if (b <= a) return this.at(s, a)
    return (this.areaTo(s, b) - this.areaTo(s, a)) / (b - a)
  }

  /** Largest occupancy over [a, b). */
  peak(s: number, a: number, b: number): number {
    const { level, times, blockMax } = this.occ
    let best = this.at(s, a)
    const i0 = this.last(s, a) + 1 > this.occ.offsets[s] ? this.last(s, a) + 1 : this.occ.offsets[s]
    const end = this.occ.offsets[s + 1]
    let i = i0
    // events in (a, b): whole blocks by their maxima, the partial ones event by event
    while (i < end && times[i] < b) {
      if (i % BLOCK === 0 && i + BLOCK <= end && times[i + BLOCK - 1] < b) {
        if (blockMax[i / BLOCK] > best) best = blockMax[i / BLOCK]
        i += BLOCK
      } else {
        if (level[i] > best) best = level[i]
        i++
      }
    }
    return best
  }
}
