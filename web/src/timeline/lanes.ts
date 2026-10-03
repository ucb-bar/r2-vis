// Task lanes: bars from issue to complete, one Path2D per color slot. Where bars are
// narrower than a pixel, one column per pixel shows the lane's busy fraction (prefix sums
// of the lane index) in the color of a task in that pixel.
import type { LaneIndex } from '../data/derive'
import type { Viewport } from './viewport'

/** Receives the shapes of a lane, in CSS px relative to the lane's plot origin. */
export interface LaneSink {
  bar(slot: number, x: number, y: number, w: number, h: number, task: number): void
  column(slot: number, x: number, y: number, h: number): void
  chunk(slot: number, x: number, y: number, w: number, h: number): void
  tail(slot: number, x: number, y: number, w: number): void
}

export interface ChunkIndex {
  first: Int32Array        // per task row: first chunk row (LaneIndex.chunkFirst)
  count: Int32Array        // per task row: number of chunks (tasks.n_chunks)
  start: Float64Array
  end: Float64Array
}

const CHUNK_MIN_PX = 24

/** First position in [a, b) whose running maximum end is after t. */
function firstReaching(idx: LaneIndex, a: number, b: number, t: number): number {
  let lo = a
  let hi = b
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (idx.maxEnd[mid] <= t) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** First position in [a, b) issued at or after t. */
function firstIssuedFrom(idx: LaneIndex, a: number, b: number, t: number): number {
  let lo = a
  let hi = b
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (idx.issue[mid] < t) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** Draws a lane of `h` px: each task in its sub-row (h / depth px), or, where tasks are
 * narrower than a pixel, one column per pixel as tall as the average number of active
 * tasks over the lane's depth, in the dominant kind of a sample of the pixel's tasks.
 * `tick` > 0 (Neutrino lanes): every task is at least `tick` px wide, and every pixel
 * column that holds a task is a full-height tick. */
export function drawLane(out: LaneSink, idx: LaneIndex, lane: number, slots: Uint8Array,
  chunks: ChunkIndex, v: Viewport, width: number, h: number, tick = 0): void {
  const a = idx.start[lane]
  const b = idx.start[lane + 1]
  if (a === b) return
  const { t0, cpp } = v
  const t1 = t0 + width * cpp
  const depth = idx.depth[lane]
  const subH = h / depth
  const counts = new Int32Array(16)
  let p = firstReaching(idx, a, b, t0)
  while (p < b && idx.issue[p] < t1) {
    const xs = (idx.issue[p] - t0) / cpp
    const xe = (idx.end[p] - t0) / cpp
    if (xe - xs >= 1) {
      const l = Math.max(xs, -2)
      const r = Math.min(Math.max(xe, xs + tick), width + 2)
      const gap = r - l > 4 ? 1 : 0
      const task = idx.order[p]
      const slot = slots[task]
      const y = idx.sub[p] * subH
      const bh = Math.max(1, subH - (depth > 1 ? 1 : 0))
      out.bar(slot, l, y, r - l - gap, bh, task)
      // The completion tail [last chunk end, complete): a thin line at the bar's middle.
      const xt = Math.min((idx.complete[p] - t0) / cpp, width + 2)
      if (xt - r >= 1) out.tail(slot, r, y + bh / 2, xt - r)
      if (r - l >= CHUNK_MIN_PX && bh >= 6) {
        for (let c = chunks.first[task]; c < chunks.first[task] + chunks.count[task]; c++) {
          const cl = Math.max((chunks.start[c] - t0) / cpp, l)
          const cr = Math.min((chunks.end[c] - t0) / cpp, r - gap)
          if (cr - cl >= 3) out.chunk(slot, cl + 1, y + 2, cr - cl - 2, bh - 4)
        }
      }
      p++
      continue
    }
    const col = Math.floor(xs)
    const colEnd = t0 + (col + 1) * cpp
    const q = Math.max(p + 1, firstIssuedFrom(idx, p, b, colEnd))
    const last = q - 1
    const busy = idx.busyPrefix[last] + (idx.end[last] - idx.issue[last]) - idx.busyPrefix[p]
    const hh = tick ? h : Math.max(2, Math.min(1, busy / (cpp * depth)) * h)
    if (col >= -1 && col <= width) {
      const slot = dominant(idx, slots, p, q, counts)
      if (tick) out.bar(slot, col, 0, tick, hh, -1)
      else out.column(slot, col, h - hh, hh)
    }
    p = q
  }
}

/** The most frequent color slot among up to 16 tasks sampled evenly from positions [p, q). */
function dominant(idx: LaneIndex, slots: Uint8Array, p: number, q: number, counts: Int32Array): number {
  const n = q - p
  if (n === 1) return slots[idx.order[p]]
  counts.fill(0)
  const k = Math.min(16, n)
  let best = 0
  for (let i = 0; i < k; i++) {
    const s = slots[idx.order[p + Math.floor((i * n) / k)]]
    if (++counts[s] > counts[best]) best = s
  }
  return best
}

/** The task row under time t in sub-row `sub` of a lane (within `tol` cycles), or -1. */
export function taskAt(idx: LaneIndex, lane: number, sub: number, t: number, tol: number): number {
  const a = idx.start[lane]
  const b = idx.start[lane + 1]
  const q = firstIssuedFrom(idx, a, b, t + tol)
  let best = -1
  let bestDist = Infinity
  for (let p = q - 1; p >= a && p >= q - 256; p--) {
    if (idx.maxEnd[p] < t - tol) break
    if (idx.sub[p] !== sub) continue
    const s = idx.issue[p]
    const e = idx.end[p]
    const dist = t < s ? s - t : t > e ? t - e : 0
    if (dist <= tol && (dist < bestDist || (dist === bestDist && e - s < idx.end[best] - idx.issue[best]))) {
      best = p
      bestDist = dist
    }
  }
  return best < 0 ? -1 : idx.order[best]
}

/** Task rows of a lane whose bar is at least `minPx` wide in the view, at most `max`;
 * null if the lane has more than `max` tasks in the window (not worth scanning). */
export function wideTasks(idx: LaneIndex, lane: number, v: Viewport, width: number, minPx: number,
  max: number): number[] | null {
  const a = idx.start[lane]
  const b = idx.start[lane + 1]
  const t1 = v.t0 + width * v.cpp
  const p0 = firstReaching(idx, a, b, v.t0)
  const p1 = firstIssuedFrom(idx, a, b, t1)
  if (p1 - p0 > max * 4) return null
  const out: number[] = []
  for (let p = p0; p < p1; p++) {
    if ((idx.end[p] - idx.issue[p]) / v.cpp >= minPx) {
      out.push(idx.order[p])
      if (out.length > max) return null
    }
  }
  return out
}
