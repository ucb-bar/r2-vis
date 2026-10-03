// Fabric nodes (a bus with its ports, a bridge with its directions) from the dimension
// tables, shared by the timeline rows and the precomputed MAX series of the bin levels.
import type { DimName, Row } from './trace'

export interface FabricEntity {
  path: string
  kind: 'bus' | 'bridge'
}

/** The bus (ports, shared bus) or bridge (directions) a resource belongs to, or null. */
export function fabricOf(dims: Record<DimName, Row[]>, r: Row): FabricEntity | null {
  if (r.role === 'port' || r.role === 'bus') {
    const bus = r.bus as number | null
    return bus === null ? null : { path: String(dims.buses[bus].path), kind: 'bus' }
  }
  if (r.role === 'bridge') {
    const b = r.bridge as number | null
    return b === null ? null : { path: String(dims.bridges[b].path), kind: 'bridge' }
  }
  return null
}

/** All fabric nodes with their resources that have a ceiling, in resource order, as flat
 * arrays for a worker: group g has members[start[g], start[g + 1]). */
export function fabricGroups(dims: Record<DimName, Row[]>): { paths: string[]; start: Int32Array; members: Int32Array } {
  const byPath = new Map<string, number[]>()
  for (const r of dims.resources) {
    const e = fabricOf(dims, r)
    if (!e || !((r.ceiling as number | null) ?? 0)) continue
    const list = byPath.get(e.path) ?? []
    list.push(r.id as number)
    byPath.set(e.path, list)
  }
  const paths = [...byPath.keys()]
  const start = new Int32Array(paths.length + 1)
  paths.forEach((p, g) => { start[g + 1] = start[g] + (byPath.get(p) as number[]).length })
  const members = new Int32Array(start[paths.length])
  paths.forEach((p, g) => members.set(byPath.get(p) as number[], start[g]))
  return { paths, start, members }
}
