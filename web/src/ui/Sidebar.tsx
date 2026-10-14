import { useEffect, useRef, useState, type ReactNode } from 'react'

const KEY = 'r2vis.sidebar'
const MIN_WIDTH = 180

interface Saved {
  width: number
  collapsed: boolean
}

function load(key: string, width: number): Saved {
  try {
    const s = JSON.parse(localStorage.getItem(key) ?? '') as Partial<Saved>
    return { width: Math.max(MIN_WIDTH, Number(s.width) || width), collapsed: !!s.collapsed }
  } catch {
    return { width, collapsed: false }
  }
}

function save(key: string, s: Saved): void {
  try {
    localStorage.setItem(key, JSON.stringify(s))
  } catch {
    // storage unavailable: the width is not kept
  }
}

/** The right sidebar: resizable by its left edge (at least 180 px), collapsible to a thin
 * strip; its width and state persist (per `name`: each view keeps its own). */
export function Sidebar({ children, name = '', width = 260 }: { children: ReactNode; name?: string; width?: number }) {
  const key = name ? `${KEY}.${name}` : KEY
  const [state, setState] = useState<Saved>(() => load(key, width))
  const drag = useRef<{ x: number; w: number } | null>(null)
  useEffect(() => save(key, state), [key, state])
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

/** A titled sidebar section; a click on the title collapses it (kept per `view` and title). */
export function Section({ title, view = '', children }: { title: string; view?: string; children: ReactNode }) {
  const key = `${KEY}.section.${view}.${title}`
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem(key) !== 'closed' } catch { return true }
  })
  const toggle = () => {
    setOpen(!open)
    try { localStorage.setItem(key, open ? 'closed' : 'open') } catch { /* not kept */ }
  }
  return (
    <section className={open ? 'sidebar-section' : 'sidebar-section closed'}>
      <h3><button className="section-title" aria-expanded={open} onClick={toggle}>
        <span className="section-fold">{open ? '▾' : '▸'}</span>{title}</button></h3>
      {open && children}
    </section>
  )
}

/** A small heading inside a section. */
export function Subhead({ children }: { children: ReactNode }) {
  return <div className="sidebar-subhead">{children}</div>
}
