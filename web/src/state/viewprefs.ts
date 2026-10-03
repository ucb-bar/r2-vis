// The view state that persists per trace in localStorage: hidden rows, row heights, row
// order inside node groups, smoothing, the Blocks selection. Keyed by the run identity of
// the manifest.
import type { Manifest } from '../data/manifest'

export interface ViewPrefs {
  hidden: string[]                    // row keys
  heights: Record<string, number>     // row key -> height in CSS px
  order: Record<string, string[]>     // node path -> row keys of its own rows, in order
  smoothing: number                   // moving-average window in pixels (1 = off)
  uncheckedBlocks: string[]           // node paths not shown (Blocks panel)
}

export const DEFAULT_PREFS: ViewPrefs = { hidden: [], heights: {}, order: {}, smoothing: 1, uncheckedBlocks: [] }

/** A short stable key from the run identity (config, program, params, commit, created). */
export function prefsKey(m: Manifest): string {
  const r = m.run ?? {}
  const identity = JSON.stringify([r.config, r.program, r.params, r.overrides, r.sim_commit, r.created, m.end_time])
  let h = 2166136261
  for (let i = 0; i < identity.length; i++) {
    h ^= identity.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return `r2vis.view.${(h >>> 0).toString(16)}`
}

export function loadPrefs(key: string): ViewPrefs {
  try {
    const text = localStorage.getItem(key)
    if (!text) return { ...DEFAULT_PREFS }
    const p = JSON.parse(text) as Partial<ViewPrefs>
    return {
      hidden: Array.isArray(p.hidden) ? p.hidden : [],
      heights: p.heights && typeof p.heights === 'object' ? p.heights : {},
      order: p.order && typeof p.order === 'object' ? p.order : {},
      smoothing: typeof p.smoothing === 'number' ? p.smoothing : 1,
      uncheckedBlocks: Array.isArray(p.uncheckedBlocks) ? p.uncheckedBlocks : [],
    }
  } catch {
    return { ...DEFAULT_PREFS }
  }
}

export function savePrefs(key: string, p: ViewPrefs): void {
  try {
    localStorage.setItem(key, JSON.stringify(p))
  } catch {
    // storage unavailable (private mode, quota): the view state is not kept
  }
}

export function clearPrefs(key: string): void {
  try {
    localStorage.removeItem(key)
  } catch {
    // nothing to clear
  }
}
