import { useRef, useState, type ReactNode } from 'react'

interface Props {
  onFiles: (list: FileList) => void
  onDrop: (dt: DataTransfer) => void
  compact?: boolean
  children?: ReactNode
}

/** Folder picker and drop zone for a .r2t directory. */
export function OpenPanel({ onFiles, onDrop, compact, children }: Props) {
  const input = useRef<HTMLInputElement>(null)
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
  return (
    <div
      className={over ? 'drop active' : 'drop'}
      title="local files only, no upload"
      onDragOver={(e) => { e.preventDefault(); setOver(true) }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); onDrop(e.dataTransfer) }}
    >
      <div>Drop a <code>.r2t</code> folder here</div>
      {picker}
      {children}
    </div>
  )
}
