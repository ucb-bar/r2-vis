// The area a view is shown in (ui/Workspace.tsx): view-local state that persists per area
// with the layout (the sidebar). Outside an area the state is the view's own.
import { createContext, useCallback, useContext, useState } from 'react'

export interface AreaApi {
  id: string
  /** the area header's place for the view's own controls (before split, close, maximize) */
  slot: HTMLElement | null
  ui: (key: string) => unknown
  setUi: (key: string, value: unknown) => void
}

export const AreaContext = createContext<AreaApi | null>(null)

/** A state that the area keeps (from `initial` if the area has none yet). */
export function useAreaState<T>(key: string, initial: () => T): [T, (v: T | ((prev: T) => T)) => void] {
  const area = useContext(AreaContext)
  const [value, setValue] = useState<T>(() => {
    const v = area?.ui(key)
    return v === undefined ? initial() : (v as T)
  })
  const set = useCallback((v: T | ((prev: T) => T)) => {
    setValue((prev) => {
      const next = typeof v === 'function' ? (v as (p: T) => T)(prev) : v
      area?.setUi(key, next)
      return next
    })
  }, [area, key])
  return [value, set]
}
