import { useEffect, useRef, useState, type ReactNode } from 'react'

const KEY = 'r2vis.sidebar'
const MIN_WIDTH = 180

interface Saved {
  width: number
  collapsed: boolean
}

function load(): Saved {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? '') as Partial<Saved>
    return { width: Math.max(MIN_WIDTH, Number(s.width) || 260), collapsed: !!s.collapsed }
  } catch {
    return { width: 260, collapsed: false }
  }
}

function save(s: Saved): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch {
    // storage unavailable: the width is not kept
  }
}

/** The right sidebar: resizable by its left edge (at least 180 px), collapsible to a thin
 * strip; its width and state persist. */
export function Sidebar({ children }: { children: ReactNode }) {
  const [state, setState] = useState<Saved>(load)
  const drag = useRef<{ x: number; w: number } | null>(null)
  useEffect(() => save(state), [state])
  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (!drag.current) return
      const w = Math.max(MIN_WIDTH, Math.min(window.innerWidth * 0.6, drag.current.w + drag.current.x - e.clientX))
      setState((s) => ({ ...s, width: w }))
    }
    const up = () => { drag.current = null }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
  }, [])
  if (state.collapsed) {
    return (
      <aside className="sidebar collapsed">
        <button className="sidebar-toggle" aria-label="show the sidebar" onClick={() => setState((s) => ({ ...s, collapsed: false }))}>‹</button>
      </aside>
    )
  }
  return (
    <aside className="sidebar" style={{ width: state.width }}>
      <div className="sidebar-edge" onPointerDown={(e) => { e.preventDefault(); drag.current = { x: e.clientX, w: state.width } }} />
      <button className="sidebar-toggle" aria-label="collapse the sidebar" onClick={() => setState((s) => ({ ...s, collapsed: true }))}>›</button>
      <div className="sidebar-body">{children}</div>
    </aside>
  )
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="sidebar-section">
      <h3>{title}</h3>
      {children}
    </section>
  )
}
