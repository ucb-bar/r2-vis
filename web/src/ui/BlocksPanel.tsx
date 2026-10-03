import { useEffect, useState } from 'react'
import type { BlockSelection } from '../state/blocks'
import type { Row } from '../data/trace'

interface Props {
  nodes: Row[]
  blocks: BlockSelection
  onClose: () => void
}

/** The node tree with checkboxes: which blocks the timeline shows. */
export function BlocksPanel({ nodes, blocks, onClose }: Props) {
  const [checked, setChecked] = useState(blocks.get())
  useEffect(() => blocks.subscribe(setChecked), [blocks])
  const depth = (n: Row) => String(n.path).split('.').length - 1
  const ids = nodes.map((n) => n.id as number)
  return (
    <div className="blocks-panel">
      <div className="side-panel-head">
        <button className="button small" onClick={() => blocks.setAll(ids, true)}>All</button>
        <button className="button small" onClick={() => blocks.setAll(ids, false)}>None</button>
        <button className="button small" onClick={onClose} aria-label="close">×</button>
      </div>
      <div className="blocks-tree">
        {nodes.map((n) => (
          <label key={n.id as number} className="tree-item" style={{ paddingLeft: `calc(var(--space-3) + ${depth(n) * 16}px)` }}>
            <input type="checkbox" checked={checked.has(n.id as number)}
              onChange={(e) => blocks.setChecked(n.id as number, e.target.checked)} />
            {String(n.path).split('.').pop()}
          </label>
        ))}
      </div>
    </div>
  )
}
