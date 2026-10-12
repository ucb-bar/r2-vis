import { useEffect, useState } from 'react'
import { applyThemeMode, loadThemeMode, THEME_MODES, type ThemeMode } from '../theme/mode'
import { onThemeChange } from '../theme/theme'

/** The color scheme switch of the top bar: system, light, dark. */
export function ThemeToggle() {
  const [mode, setMode] = useState<ThemeMode>(loadThemeMode)
  return (
    <div className="segmented theme-toggle" role="radiogroup" aria-label="color scheme">
      {THEME_MODES.map((m) => (
        <button key={m} role="radio" aria-checked={mode === m} className={mode === m ? 'seg active' : 'seg'}
          onClick={() => { applyThemeMode(m); setMode(m) }}>{m}</button>
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
