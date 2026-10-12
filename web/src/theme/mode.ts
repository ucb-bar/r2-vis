// The color scheme the user picks (top bar): system (prefers-color-scheme), light or dark.
// Light and dark set :root[data-theme]; system removes it. Kept in localStorage.

export type ThemeMode = 'system' | 'light' | 'dark'
export const THEME_MODES: ThemeMode[] = ['system', 'light', 'dark']
const KEY = 'r2vis.theme'

export function loadThemeMode(): ThemeMode {
  try {
    const v = localStorage.getItem(KEY) as ThemeMode | null
    return v && THEME_MODES.includes(v) ? v : 'system'
  } catch {
    return 'system'
  }
}

/** Applies a mode to the document (the views redraw through onThemeChange) and keeps it. */
export function applyThemeMode(mode: ThemeMode, save = true): void {
  const root = document.documentElement
  if (mode === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', mode)
  if (!save) return
  try { localStorage.setItem(KEY, mode) } catch { /* not kept */ }
}
