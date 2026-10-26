// "Recent servers": the r2t-serve servers opened before (data/servers.ts). A click on one
// opens its trace list; × removes it. With a served trace open (the header), the menu lists
// that server's traces first, so another trace of it is two clicks away.
import { useEffect, useRef, useState } from 'react'
import { serverLabel, type SavedServer } from '../data/servers'
import { InlineIcon } from './Areas'

interface Props {
  servers: SavedServer[]
  /** the server of the open trace and its traces (the header) */
  current?: { base: string; traces: string[]; open: string } | null
  onServer: (url: string) => void
  onTrace?: (base: string, name: string) => void
  onRemove: (url: string) => void
}

export function ServerMenu({ servers, current, onServer, onTrace, onRemove }: Props) {
  const [open, setOpen] = useState(false)
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const away = (e: PointerEvent) => { if (!host.current?.contains(e.target as globalThis.Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('pointerdown', away)
    window.addEventListener('keydown', esc)
    return () => { window.removeEventListener('pointerdown', away); window.removeEventListener('keydown', esc) }
  }, [open])
  if (!servers.length && !current) return null
  const pick = (f: () => void) => { setOpen(false); f() }
  return (
    <div className="server-menu" ref={host}>
      <button type="button" className={open ? 'button active' : 'button'} aria-expanded={open} onClick={() => setOpen(!open)}>
        Recent servers ▾
      </button>
      {open && (
        <div className="menu">
          {current && onTrace && (
            <>
              <div className="menu-title">{serverLabel(current.base)}</div>
              {current.traces.map((t) => (
                <button key={t} type="button" className={t === current.open ? 'menu-item current' : 'menu-item'} disabled={t === current.open}
                  onClick={() => pick(() => onTrace(current.base, t))}>{t}</button>
              ))}
              {servers.length > 0 && <div className="menu-sep" />}
            </>
          )}
          {servers.map((s) => (
            <div key={s.url} className="menu-row">
              <button type="button" className="menu-item" onClick={() => pick(() => onServer(s.url))}>{serverLabel(s.url)}</button>
              <InlineIcon icon="close" tip="Remove" onClick={() => onRemove(s.url)} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
