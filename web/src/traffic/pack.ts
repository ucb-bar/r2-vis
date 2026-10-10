// Interval packing of the traffic layout (views-design 6.6). Every unit (a box with its
// strips, or the strips of one link) occupies x intervals in columns (a strip: from its
// start box to its end box, the bus boxes it passes behind included) and a y range in px
// around its center. In the layout's order, each unit takes the highest y where none of
// its parts overlaps a part placed before (first fit, the left-edge rule: units of one
// column and of different columns share a height when their x intervals do not overlap),
// and no higher than the bottom of everything placed before its band opened (the bands of
// sibling nodes do not interleave, so their bus boxes do not overlap).
import { LOOP_LEG, type Layout, type PLink, type PUnit } from './layout'

export interface PackSizes {
  /** slot pitch, strip height, gap between strips, gap between boxes (px) */
  pitch: number
  strip: number
  gap: number
  boxGap: number
  boxHeight: (slots: number) => number
}

const EPS = 0.04   // columns: a strip that ends on a bus stops at the side of the bus box

interface Rect {
  a: number
  b: number
  y0: number
  y1: number
}

/** The x interval (columns) of a link's strips. */
function stripSpan(l: PLink): [number, number] {
  const a = Math.min(l.x0, l.x1)
  const b = Math.max(l.x0, l.x1)
  if (l.kind === 'att' || l.kind === 'cross') return l.x1 > l.x0 ? [a, b - EPS] : [a + EPS, b]
  if (l.kind === 'link') return [a + EPS, b - EPS]
  return [a, b]
}

/** The parts of a unit, y relative to its center, each with half the gap on both sides. */
function parts(u: PUnit, P: PackSizes): Rect[] {
  const out: Rect[] = []
  const slots = u.box ? u.box.slots : u.links[0].slots
  const off = (s: number) => (s - (slots - 1) / 2) * P.pitch
  if (u.box) {
    const h = P.boxHeight(u.box.slots)
    out.push({ a: u.box.x0, b: u.box.x1, y0: -h / 2 - P.boxGap / 2, y1: h / 2 + P.boxGap / 2 })
  }
  for (const l of u.links) {
    const [a, b] = stripSpan(l)
    const last = l.kind === 'self' ? l.slot + LOOP_LEG : l.slot + l.strips.length - 1
    out.push({ a, b, y0: off(l.slot) - P.strip / 2 - P.gap / 2, y1: off(last) + P.strip / 2 + P.gap / 2 })
  }
  return out
}

const overlapX = (p: Rect, r: Rect) => p.a < r.b && r.a < p.b

/** Gives every box and link of the layout its center y, the node bands and the height. */
export function pack(lay: Layout, P: PackSizes): void {
  const rects: Rect[] = []
  const open = new Map<string, { y0: number; label: string; isNode: boolean; nest: number }>()
  let nest = 0
  let bottom = 0
  lay.bands = []
  for (const s of lay.seq) {
    if ('open' in s) {
      open.set(s.open, { y0: bottom, label: s.label, isNode: s.isNode, nest: nest++ })
      continue
    }
    if ('close' in s) {
      const b = open.get(s.close)
      nest--
      if (b && b.label && bottom > b.y0) lay.bands.push({ y0: b.y0, y1: bottom, label: b.label, key: s.close, nest: b.nest, isNode: b.isNode })
      continue
    }
    const ps = parts(s, P)
    const floor = open.get(s.band)?.y0 ?? 0
    const lowest = floor - Math.min(...ps.map((p) => p.y0))
    const near = rects.filter((r) => r.y1 > floor && ps.some((p) => overlapX(p, r)))
    const cands = [lowest]
    for (const r of near) for (const p of ps) if (overlapX(p, r)) cands.push(r.y1 - p.y0)
    cands.sort((x, y) => x - y)
    const free = (c: number) => ps.every((p) => near.every((r) =>
      !overlapX(p, r) || r.y0 >= c + p.y1 - 1e-6 || c + p.y0 >= r.y1 - 1e-6))
    // The last candidate is below every part it overlaps: free.
    const c = cands.find((y) => y >= lowest && free(y)) ?? cands[cands.length - 1]
    for (const p of ps) {
      rects.push({ a: p.a, b: p.b, y0: c + p.y0, y1: c + p.y1 })
      bottom = Math.max(bottom, c + p.y1)
    }
    if (s.box) s.box.yc = c
    for (const l of s.links) l.yc = c
  }
  lay.height = bottom
}
