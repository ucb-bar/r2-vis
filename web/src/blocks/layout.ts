// Layout of the block diagram in world units: every node is a box, its children a grid
// inside it, in node order, with cells near the screen's aspect ratio.
import type { Trace } from '../data/trace'

export interface Box {
  node: number
  path: string
  name: string
  x: number
  y: number
  w: number
  h: number
  /** height of the header and strips band at the top (the whole box for a leaf) */
  band: number
  children: Box[]
}

const BAND = 0.26    // header and strips: this part of a box with children
const PAD = 0.03     // padding of the children grid, as a part of the box width
const GAP = 0.04     // gap between cells, as a part of the cell size

export function layout(trace: Trace, aspect: number): Box {
  const nodes = trace.dims.nodes
  const children = new Map<number, number[]>()
  for (const n of nodes) {
    const p = n.parent as number | null
    if (p !== null) children.set(p, [...(children.get(p) ?? []), n.id as number])
  }
  const root = nodes.find((n) => n.parent === null)?.id as number
  const make = (id: number, x: number, y: number, w: number, h: number): Box => {
    const path = String(nodes[id].path)
    const kids = children.get(id) ?? []
    const box: Box = { node: id, path, name: path.split('.').pop() ?? path, x, y, w, h,
      band: kids.length ? h * BAND : h, children: [] }
    if (kids.length) {
      const pad = w * PAD
      const gx = x + pad
      const gy = y + box.band
      const gw = w - 2 * pad
      const gh = h - box.band - pad
      const cols = Math.max(1, Math.min(kids.length, Math.round(Math.sqrt((kids.length * (gw / gh)) / aspect))))
      const rows = Math.ceil(kids.length / cols)
      const cw = gw / cols
      const ch = gh / rows
      kids.forEach((k, i) => {
        const c = i % cols
        const r = Math.floor(i / cols)
        const g = Math.min(cw, ch) * GAP
        box.children.push(make(k, gx + c * cw + g / 2, gy + r * ch + g / 2, cw - g, ch - g))
      })
    }
    return box
  }
  return make(root, 0, 0, 1000, 1000 / aspect)
}

/** The deepest box under world point (x, y), or null. */
export function boxAt(box: Box, x: number, y: number): Box | null {
  if (x < box.x || y < box.y || x > box.x + box.w || y > box.y + box.h) return null
  for (const c of box.children) {
    const hit = boxAt(c, x, y)
    if (hit) return hit
  }
  return box
}
