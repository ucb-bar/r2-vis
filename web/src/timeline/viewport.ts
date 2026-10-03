// The visible time range: left edge t0 (cycles) and cycles per CSS pixel.

export interface Viewport {
  t0: number
  cpp: number
}

export const MIN_CPP = 1 / 64     // 64 px per cycle at most

export function clampViewport(v: Viewport, width: number, endTime: number): Viewport {
  const maxCpp = Math.max(1, (endTime * 1.05) / Math.max(1, width))
  const cpp = Math.min(maxCpp, Math.max(MIN_CPP, v.cpp))
  const span = cpp * width
  const margin = endTime * 0.025
  const t0 = Math.min(Math.max(v.t0, -margin), endTime + margin - span)
  return { t0: span >= endTime + 2 * margin ? -margin : t0, cpp }
}

/** Zoom by `factor` (> 1 zooms in) keeping the time under pixel x fixed. */
export function zoomAt(v: Viewport, x: number, factor: number): Viewport {
  const t = v.t0 + x * v.cpp
  const cpp = v.cpp / factor
  return { t0: t - x * cpp, cpp }
}

export function fit(width: number, endTime: number): Viewport {
  const margin = endTime * 0.025
  return { t0: -margin, cpp: (endTime + 2 * margin) / Math.max(1, width) }
}

/** Tick step: 1, 2 or 5 times a power of ten, at least `minPx` pixels apart. */
export function tickStep(cpp: number, minPx: number): number {
  const raw = cpp * minPx
  const p = 10 ** Math.floor(Math.log10(raw))
  for (const m of [1, 2, 5, 10]) if (m * p >= raw) return Math.max(1, m * p)
  return Math.max(1, 10 * p)
}

/** A tick label: k, M or G with the decimals the step needs; whole cycles with digit
 * grouping when a short form cannot tell neighbouring ticks apart. */
export function formatCycles(t: number, step: number): string {
  if (Math.abs(t) < step / 2) t = 0  // no "-0"
  const abs = Math.abs(t)
  const units: [number, string][] = [[1e9, 'G'], [1e6, 'M'], [1e3, 'k']]
  for (const [unit, name] of units) {
    if (abs >= unit) {
      const digits = Math.max(0, Math.ceil(-Math.log10(step / unit) - 1e-9))
      if (digits > 3) break
      return `${(t / unit).toFixed(digits)} ${name}`
    }
  }
  return Math.round(t).toLocaleString('en-US')
}

const ZOOM_MAX_LOG = Math.log(2)

/** Zoom factor of one ctrl+wheel event: a trackpad pinch gives small deltas (a smooth
 * zoom), a ctrl+mouse wheel notch about 100 px; clamped to a factor of 2 per event. */
export function zoomFactor(deltaPx: number): number {
  return Math.exp(-Math.max(-ZOOM_MAX_LOG, Math.min(ZOOM_MAX_LOG, deltaPx * 0.01)))
}
