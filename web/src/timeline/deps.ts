// Dependencies of tasks: producers (deps sorted by consumer) and consumers (the reverse
// index, built in a worker on first use), and the arrows between task bars.
import type { DepsByProducer } from '../data/derive'
import type { WorkerPool } from '../data/pool'
import type { Trace } from '../data/trace'

export interface Dep {
  row: number        // deps row
  other: number      // task row of the other end, -1 if it has no task row (outside the trace)
  remote: boolean
}

export class DepIndex {
  private readonly gid: Int32Array            // tasks.gid, ascending
  private readonly consumer: Int32Array       // deps.consumer, ascending
  private readonly producer: Int32Array
  private readonly remote: Uint8Array
  private reverse: DepsByProducer | null = null
  private building: Promise<void> | null = null
  onReady: (() => void) | null = null

  constructor(trace: Trace) {
    this.gid = trace.facts.tasks.cols.gid as Int32Array
    const d = trace.facts.deps.cols
    this.consumer = d.consumer as Int32Array
    this.producer = d.producer as Int32Array
    this.remote = d.remote as Uint8Array
  }

  /** Task row of a gid, or -1. */
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

  /** Producers of a task (store-written ranges, with no producer, are left out). */
  producers(task: number): Dep[] {
    const g = this.gid[task]
    const c = this.consumer
    let lo = 0
    let hi = c.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (c[mid] < g) lo = mid + 1
      else hi = mid
    }
    const out: Dep[] = []
    for (let i = lo; i < c.length && c[i] === g; i++) {
      const p = this.producer[i]
      if (p < 0) continue
      out.push({ row: i, other: this.rowOf(p), remote: this.remote[i] === 1 })
    }
    return out
  }

  /** Consumers of a task, or null until the reverse index is built (it then calls onReady). */
  consumers(task: number, pool: WorkerPool): Dep[] | null {
    if (!this.reverse) {
      this.build(pool)
      return null
    }
    const g = this.gid[task]
    const { start, order } = this.reverse
    if (g + 1 >= start.length) return []
    const out: Dep[] = []
    for (let k = start[g]; k < start[g + 1]; k++) {
      const i = order[k]
      out.push({ row: i, other: this.rowOf(this.consumer[i]), remote: this.remote[i] === 1 })
    }
    return out
  }

  private build(pool: WorkerPool): void {
    if (this.building) return
    let maxGid = 0
    for (let i = 0; i < this.producer.length; i++) if (this.producer[i] > maxGid) maxGid = this.producer[i]
    const copy = this.producer.slice()
    this.building = pool.compute<DepsByProducer>({ op: 'depsByProducer', args: [copy, maxGid] }, [copy.buffer])
      .then((r) => {
        this.reverse = r
        this.onReady?.()
      })
  }
}

export interface ArrowStyle {
  color: string
  dash: boolean
  width: number
  /** an S-curve (hover arrows), else a straight line (cheaper: "show all") */
  curve: boolean
}

/** Arrows batched per style; heads are filled triangles. */
export class ArrowBatch {
  private readonly lines = new Map<string, { style: ArrowStyle; path: Path2D; heads: Path2D }>()
  private readonly labels: { x: number; y: number; text: string; color: string }[] = []
  count = 0

  add(style: ArrowStyle, x0: number, y0: number, x1: number, y1: number): void {
    const key = `${style.color}|${style.dash}|${style.width}|${style.curve}`
    let b = this.lines.get(key)
    if (!b) {
      b = { style, path: new Path2D(), heads: new Path2D() }
      this.lines.set(key, b)
    }
    b.path.moveTo(x0, y0)
    if (style.curve) {
      // A gentle S-curve from the producer's end to the consumer's start.
      const dx = Math.max(12, Math.abs(x1 - x0) * 0.4)
      b.path.bezierCurveTo(x0 + dx, y0, x1 - dx, y1, x1, y1)
    } else b.path.lineTo(x1, y1)
    // The head (fill closes the triangle); none on a very short arrow.
    const size = 5
    if (Math.abs(x1 - x0) + Math.abs(y1 - y0) >= 6) {
      b.heads.moveTo(x1, y1)
      b.heads.lineTo(x1 - size, y1 - size * 0.6)
      b.heads.lineTo(x1 - size, y1 + size * 0.6)
    }
    this.count++
  }

  private readonly labelKeys = new Set<string>()

  /** A text label; the same text near the same place is drawn once. */
  label(x: number, y: number, text: string, color: string): void {
    const key = `${text}|${Math.round(x / 40)}|${Math.round(y / 10)}`
    if (this.labelKeys.has(key)) return
    this.labelKeys.add(key)
    this.labels.push({ x, y, text, color })
  }

  draw(ctx: CanvasRenderingContext2D, font: string, halo: string): void {
    for (const { style, path, heads } of this.lines.values()) {
      ctx.strokeStyle = style.color
      ctx.fillStyle = style.color
      ctx.lineWidth = style.width
      ctx.setLineDash(style.dash ? [4, 3] : [])
      ctx.stroke(path)
      ctx.setLineDash([])
      ctx.fill(heads)
    }
    ctx.font = font
    ctx.textBaseline = 'middle'
    for (const l of this.labels) {
      const w = ctx.measureText(l.text).width
      ctx.fillStyle = halo
      ctx.fillRect(l.x - 2, l.y - 7, w + 4, 14)
      ctx.fillStyle = l.color
      ctx.fillText(l.text, l.x, l.y)
    }
  }
}
