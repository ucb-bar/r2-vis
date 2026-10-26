import { useRef, useState, type ReactNode } from 'react'

interface Props {
  onFiles: (list: FileList) => void
  onDrop: (dt: DataTransfer) => void
  /** a source map (.json) picked or dropped (the Source view) */
  onSourceMap?: (file: File) => void
  /** an r2t-serve URL (a server or a trace) */
  onUrl?: (url: string) => void
  compact?: boolean
  /** the recent servers, next to the Open URL field */
  recent?: ReactNode
  children?: ReactNode
}

/** Folder picker and drop zone for a .r2t directory, and a file picker for a source map. */
export function OpenPanel({ onFiles, onDrop, onSourceMap, onUrl, compact, recent, children }: Props) {
  const input = useRef<HTMLInputElement>(null)
  const srcInput = useRef<HTMLInputElement>(null)
  const [url, setUrl] = useState('')
  const [over, setOver] = useState(false)
  const picker = (
    <>
      <button className={compact ? 'button' : 'button primary'} onClick={() => input.current?.click()}>
        Open trace folder…
      </button>
      <input
        ref={input} type="file" hidden multiple
        // @ts-expect-error webkitdirectory is not in the React types
        webkitdirectory=""
        onChange={(e) => { if (e.target.files?.length) onFiles(e.target.files); e.target.value = '' }}
      />
    </>
  )
  if (compact) return picker
  // A dropped .json file is a source map; anything else is a trace folder.
  const drop = (dt: DataTransfer) => {
    const f = dt.files.length === 1 ? dt.files[0] : null
    if (f && onSourceMap && f.name.toLowerCase().endsWith('.json')) onSourceMap(f)
    else onDrop(dt)
  }
  return (
    <div
      className={over ? 'drop active' : 'drop'}
      title="local files only, no upload"
      onDragOver={(e) => { e.preventDefault(); setOver(true) }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); drop(e.dataTransfer) }}
    >
      <div>Drop a <code>.r2t</code> folder or a source map here</div>
      <div className="tool-row">
        {picker}
        {onSourceMap && (
          <>
            <button className="button" onClick={() => srcInput.current?.click()}>Open source map…</button>
            <input ref={srcInput} type="file" accept=".json,application/json" hidden
              onChange={(e) => { const f = e.target.files?.[0]; if (f) onSourceMap(f); e.target.value = '' }} />
          </>
        )}
      </div>
      {onUrl && (
        <form className="tool-row open-url" onSubmit={(e) => { e.preventDefault(); if (url.trim()) onUrl(url.trim()) }}>
          <input type="url" placeholder="http://127.0.0.1:8765/TOKEN/" value={url} onChange={(e) => setUrl(e.target.value)} />
          <button className="button" type="submit">Open URL</button>
          {recent}
        </form>
      )}
      {children}
    </div>
  )
}
