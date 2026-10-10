// Fabric nodes (a bus with its ports, a link with its two directions, a memory with its
// banks and write ports, a port or link direction with its write channel) from the dimension
// tables, shared by the timeline rows and the precomputed MAX series of the bin levels.
import type { DimName, Row } from './trace'

export interface FabricEntity {
  path: string
  /** bus, link: the fabric; channel: a port or link direction with a write channel (its
   * read and write channels); memory: a memory with banks or a write port; bank: a bank
   * with a write port (its port and write port) */
  kind: 'bus' | 'link' | 'channel' | 'memory' | 'bank'
}

/** The bank memories `<mem>.b<i>` (raw 1.4) by path: their memory's path. */
function banksOf(dims: Record<DimName, Row[]>): Map<string, string> {
  const count = new Map<string, number>()
  const prefix = (path: string) => /^(.*)\.b\d+$/.exec(path)?.[1]
  for (const m of dims.memories) {
    const p = prefix(String(m.path))
    if (p) count.set(p, (count.get(p) ?? 0) + 1)
  }
  const out = new Map<string, string>()
  for (const m of dims.memories) {
    const p = prefix(String(m.path))
    if (p && (count.get(p) ?? 0) > 1) out.set(String(m.path), p)
  }
  return out
}

const banksCache = new WeakMap<object, Map<string, string>>()

/** The fabric nodes a resource is in, outermost first (empty: a plain row): a port is in
 * its bus, a link direction in its link, each also in a channel node when it has a write
 * channel; a memory port or write port is in its memory node when the memory has banks or
 * a write port, and in its bank node when the bank has a write port. A cache link's
 * directions are its memory port, which is not a fabric resource. */
export function fabricChain(dims: Record<DimName, Row[]>, r: Row): FabricEntity[] {
  const has = (v: unknown) => v !== null && v !== undefined
  if (r.role === 'port' || r.role === 'bus') {
    const bus = r.bus as number | null
    if (bus === null) return []
    const bpath = String(dims.buses[bus].path)
    const out: FabricEntity[] = [{ path: bpath, kind: 'bus' }]
    if (r.role === 'port') {
      const att = dims.attachments[r.attachment as number]
      const wr = r.link_dir === 'in' ? att.in_wr_resource : att.out_wr_resource
      if (has(wr)) out.push({ path: `${bpath}.${String(att.name)}.${String(r.link_dir)}`, kind: 'channel' })
    }
    return out
  }
  if (r.role === 'link') {
    const l = r.link as number | null
    if (l === null) return []
    const link = dims.links[l]
    const out: FabricEntity[] = [{ path: String(link.path), kind: 'link' }]
    const side = r.id === link.ab_resource || r.id === link.ab_wr_resource ? 'ab' : 'ba'
    if (has(side === 'ab' ? link.ab_wr_resource : link.ba_wr_resource)) {
      out.push({ path: `${String(link.path)}.${side}`, kind: 'channel' })
    }
    return out
  }
  if (r.role === 'mem_port') {
    const m = dims.memories[r.memory as number]
    if (!m) return []
    let banks = banksCache.get(dims.memories)
    if (!banks) { banks = banksOf(dims); banksCache.set(dims.memories, banks) }
    const path = String(m.path)
    const parent = banks.get(path)
    const wport = has(m.wport)
    if (parent) return [{ path: parent, kind: 'memory' }, ...(wport ? [{ path, kind: 'bank' as const }] : [])]
    return wport ? [{ path, kind: 'memory' }] : []
  }
  return []
}

/** All fabric nodes (every level) with their resources that have a ceiling, in resource
 * order, as flat arrays for a worker: group g has members[start[g], start[g + 1]). */
export function fabricGroups(dims: Record<DimName, Row[]>): { paths: string[]; start: Int32Array; members: Int32Array } {
  const byPath = new Map<string, number[]>()
  for (const r of dims.resources) {
    if (!((r.ceiling as number | null) ?? 0)) continue
    for (const e of fabricChain(dims, r)) {
      const list = byPath.get(e.path) ?? []
      list.push(r.id as number)
      byPath.set(e.path, list)
    }
  }
  const paths = [...byPath.keys()]
  const start = new Int32Array(paths.length + 1)
  paths.forEach((p, g) => { start[g + 1] = start[g] + (byPath.get(p) as number[]).length })
  const members = new Int32Array(start[paths.length])
  paths.forEach((p, g) => members.set(byPath.get(p) as number[], start[g]))
  return { paths, start, members }
}
