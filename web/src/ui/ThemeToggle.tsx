import { useEffect, useState, type ReactElement } from 'react'
import { applyThemeMode, loadThemeMode, THEME_MODES, type ThemeMode } from '../theme/mode'
import { onThemeChange } from '../theme/theme'

/** Icons in the ink color (currentColor): a monitor, a sun, a moon. */
const ICONS: Record<ThemeMode, ReactElement> = {
  system: <><rect x="2" y="3" width="12" height="8.5" rx="1" /><path d="M6 14h4M8 11.5V14" /></>,
  light: <><circle cx="8" cy="8" r="2.8" /><path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1" /></>,
  dark: <path d="M13 9.6A5.5 5.5 0 1 1 6.4 3a4.4 4.4 0 0 0 6.6 6.6z" />,
}

/** The color scheme switch of the top bar: system, light, dark. */
export function ThemeToggle() {
  const [mode, setMode] = useState<ThemeMode>(loadThemeMode)
  return (
    <div className="segmented theme-toggle" role="radiogroup" aria-label="color scheme">
      {THEME_MODES.map((m) => (
        <button key={m} role="radio" aria-checked={mode === m} aria-label={m} title={m}
          className={mode === m ? 'seg active' : 'seg'} onClick={() => { applyThemeMode(m); setMode(m) }}>
          <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4"
            strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{ICONS[m]}</svg>
        </button>
      ))}
    </div>
  )
}

/** A number that changes when the color scheme changes: for components that read the
 * tokens while rendering. */
export function useThemeVersion(): number {
  const [v, setV] = useState(0)
  useEffect(() => onThemeChange(() => setV((x) => x + 1)), [])
  return v
}
