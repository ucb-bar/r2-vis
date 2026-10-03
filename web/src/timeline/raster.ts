// Utilization rows rasterized in JavaScript into an ImageData (device pixels) and drawn
// with putImageData: a fixed cost per pixel, with no path or rectangle raster in the
// browser (which dominates without a GPU).

export interface RowColors {
  surface: number   // packed RGBA (little-endian Uint32: 0xAABBGGRR)
  grid: number
  peak: number
  area: number      // the area color blended over the surface
  line: number
  ceiling: number
}

const probe = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true }) : null

/** [r, g, b, a] (0-255) of a CSS color. */
export function rgba(css: string): [number, number, number, number] {
  if (!probe) return [0, 0, 0, 255]
  probe.clearRect(0, 0, 1, 1)
  probe.fillStyle = css
  probe.fillRect(0, 0, 1, 1)
  const d = probe.getImageData(0, 0, 1, 1).data
  return [d[0], d[1], d[2], d[3]]
}

export function pack([r, g, b, a]: [number, number, number, number]): number {
  return ((a << 24) | (b << 16) | (g << 8) | r) >>> 0
}

/** `over` with its alpha, composited on the opaque `under`. */
export function blend(over: [number, number, number, number], under: [number, number, number, number]): [number, number, number, number] {
  const a = over[3] / 255
  return [0, 1, 2].map((i) => Math.round(over[i] * a + under[i] * (1 - a))).concat(255) as [number, number, number, number]
}

export class RowRaster {
  private img: ImageData | null = null
  private px: Uint32Array = new Uint32Array(0)

  /** Draws one row: `ys` and `peaks` are y offsets in CSS px inside the row (NaN: none). */
  draw(ctx: CanvasRenderingContext2D, dpr: number, x: number, y: number, n: number, h: number,
    ys: Float64Array, peaks: Float64Array | null, grid: number[], ceilingY: number, baseY: number,
    c: RowColors): void {
    const W = Math.max(1, Math.round(n * dpr))
    const H = Math.max(1, Math.round(h * dpr))
    if (!this.img || this.img.width !== W || this.img.height !== H) {
      this.img = new ImageData(W, H)
      this.px = new Uint32Array(this.img.data.buffer)
    }
    const px = this.px
    px.fill(c.surface)
    for (const gx of grid) {
      const col = Math.round(gx * dpr)
      if (col >= 0 && col < W) for (let r = 0; r < H; r++) px[r * W + col] = c.grid
    }
    const ceil = Math.round(ceilingY * dpr)
    if (ceil >= 0 && ceil < H) for (let col = 0; col < W; col++) if (col % 5 < 2) px[ceil * W + col] = c.ceiling
    const base = Math.min(H, Math.round(baseY * dpr))
    const lw = Math.max(2, Math.round(1.5 * dpr))
    let prevTop = -1
    for (let col = 0; col < W; col++) {
      const p = Math.min(n - 1, Math.floor(col / dpr))
      if (peaks) {
        const top = Math.max(0, Math.round(peaks[p] * dpr))
        for (let r = top; r < base; r++) px[r * W + col] = c.peak
      }
      const top = Math.max(0, Math.min(base, Math.round(ys[p] * dpr)))
      for (let r = top; r < base; r++) px[r * W + col] = c.area
      // The line: lw px around top, and the vertical join to the previous column.
      let a = top - (lw >> 1)
      let b = a + lw
      if (prevTop >= 0) {
        a = Math.min(a, prevTop - (lw >> 1))
        b = Math.max(b, prevTop - (lw >> 1) + lw)
      }
      for (let r = Math.max(0, a); r < Math.min(H, b); r++) px[r * W + col] = c.line
      prevTop = top
    }
    ctx.putImageData(this.img, Math.round(x * dpr), Math.round(y * dpr))
  }
}

/** Bars at least this wide (CSS px) are listed for text labels. */
const LABEL_BAR_PX = 14

/** Packed colors of one lane slot: the bar and its chunk outline. */
export interface SlotColors {
  bar: number
  chunk: number
}

/** A lane row rasterized into an ImageData: bars, busy columns, chunk outlines. The shapes
 * come from lanes.drawLane in CSS px relative to the row's plot origin and bar top. */
export class LaneRaster {
  private img: ImageData | null = null
  private px: Uint32Array = new Uint32Array(0)
  private W = 0
  private H = 0
  private dpr = 1
  private top = 0
  slots: SlotColors[] = []
  /** Bars wide enough for a label (CSS px, relative to the row). */
  readonly bars: { task: number; x: number; y: number; w: number; h: number }[] = []

  begin(dpr: number, n: number, h: number, barTop: number, background: number, grid: number,
    gridX: number[]): void {
    this.dpr = dpr
    this.W = Math.max(1, Math.round(n * dpr))
    this.H = Math.max(1, Math.round(h * dpr))
    this.top = barTop
    if (!this.img || this.img.width !== this.W || this.img.height !== this.H) {
      this.img = new ImageData(this.W, this.H)
      this.px = new Uint32Array(this.img.data.buffer)
    }
    this.px.fill(background)
    for (const gx of gridX) {
      const col = Math.round(gx * dpr)
      if (col >= 0 && col < this.W) for (let r = 0; r < this.H; r++) this.px[r * this.W + col] = grid
    }
    this.bars.length = 0
  }

  private fill(x: number, y: number, w: number, h: number, color: number): void {
    const d = this.dpr
    const c0 = Math.max(0, Math.round(x * d))
    const c1 = Math.min(this.W, Math.max(c0 + 1, Math.round((x + w) * d)))
    const r0 = Math.max(0, Math.round((this.top + y) * d))
    const r1 = Math.min(this.H, Math.max(r0 + 1, Math.round((this.top + y + h) * d)))
    const px = this.px
    for (let r = r0; r < r1; r++) px.fill(color, r * this.W + c0, r * this.W + c1)
  }

  bar(slot: number, x: number, y: number, w: number, h: number, task: number): void {
    this.fill(x, y, w, h, this.slots[slot].bar)
    if (task >= 0 && w >= LABEL_BAR_PX) this.bars.push({ task, x, y, w, h })
  }

  column(slot: number, x: number, y: number, h: number): void {
    this.fill(x, y, 1, h, this.slots[slot].bar)
  }

  chunk(slot: number, x: number, y: number, w: number, h: number): void {
    const c = this.slots[slot].chunk
    const t = 1 / this.dpr
    this.fill(x, y, w, t, c)
    this.fill(x, y + h - t, w, t, c)
    this.fill(x, y, t, h, c)
    this.fill(x + w - t, y, t, h, c)
  }

  tail(slot: number, x: number, y: number, w: number): void {
    this.fill(x, y - 0.5, w, 1, this.slots[slot].bar)
  }

  put(ctx: CanvasRenderingContext2D, x: number, y: number): void {
    if (this.img) ctx.putImageData(this.img, Math.round(x * this.dpr), Math.round(y * this.dpr))
  }
}
