// Attribution (views-design 7, trace-format 1.5 usage): the owners of a set of resources at
// an instant or over a range, computed in a decode worker. An owner key is a task gid
// (>= 0), a program -2 - programs.id, or -1 (no owner: a dump before raw 1.6). The owners
// are also grouped by (lane, task kind) and by task kind (a program stays its own group,
// no owner is one group), for the queries with more owners than flightlines.
import { isDict, type Column } from './parquet/decode'

export interface AttributionRequest {
  usage: File | null
  charges: File
  resources: number[]
  /** an instant (t), else the range [a, b) */
  t: number | null
  a: number
  b: number
  /** manifest.charge_blocks: row group g of charges.parquet holds charges that start in
   * [t0, t1) and end by maxEnd */
  blocks: { t0: number; t1: number; maxEnd: number }[]
  /** tasks.parquet (the lane and kind of each owner) and the opcode names (the kind of a
   * task without a label kind) */
  tasks: File
  opcodes: string[]
}

/** A group of owners: tasks of one lane and kind, tasks of one kind, a program, or no owner. */
export interface OwnerGroup {
  /** a program or no owner: its owner key; a task group: null */
  owner: number | null
  /** the lane (a kind group: the lane with the largest value); -1: none, or tasks not in
   * the trace */
  lane: number
  /** the task kind ('' for a program or no owner) */
  kind: string
  value: number
  /** tasks in the group, and the lanes they run on */
  tasks: number
  lanes: number
}

export interface Attribution {
  /** owner keys, the largest value first */
  owners: Int32Array
  /** an instant: lanes held; a range: amount */
  values: Float64Array
  total: number
  /** the owners grouped by (lane, kind) and by kind, the largest value first */
  laneKind: OwnerGroup[]
  kind: OwnerGroup[]
  /** what the query read */
  usageGroups: number
  chargeGroups: number
  /** the whole query, and the grouping in it (the first query of a worker reads the task
   * kinds) */
  ms: number
  groupMs: number
}

/** Reads columns of one row group of a file (the worker's decoder). */
export type ReadGroup = (name: string, file: File, group: number, columns: string[]) => Promise<Record<string, Column>>
/** The resource range of each row group of a file (from its footer statistics). */
export type GroupRanges = (name: string, file: File, column: string) => Promise<[number, number][]>

const ownerOf = (gid: number, program: number) => (gid >= 0 ? gid : program >= 0 ? -2 - program : -1)

/** Per task row (sorted by gid): the gid, the lane and the kind (an index into kinds). */
interface TaskKinds { gid: Int32Array; lane: Int32Array; kind: Int32Array; kinds: string[] }

let taskKinds: { key: string; value: Promise<TaskKinds> } | null = null

/** Forgets the task kinds (a new trace is opened). */
export function resetAttribution(): void {
  taskKinds = null
}

/** The task kinds of tasks.parquet, read once per trace: the label field kind, else the
 * opcode name. */
function readTaskKinds(req: AttributionRequest, read: ReadGroup, groups: number): Promise<TaskKinds> {
  const key = `${req.tasks.name}|${req.tasks.size}|${req.tasks.lastModified}`
  if (taskKinds?.key === key) return taskKinds.value
  const value = (async () => {
    const parts: Record<string, Column>[] = []
    for (let g = 0; g < groups; g++) parts.push(await read('tasks', req.tasks, g, ['gid', 'lane', 'kind', 'opcode']))
    const rows = parts.reduce((n, c) => n + (c.gid as Int32Array).length, 0)
    const out: TaskKinds = { gid: new Int32Array(rows), lane: new Int32Array(rows), kind: new Int32Array(rows), kinds: [] }
    const index = new Map<string, number>()
    const kindOf = (name: string) => {
      let k = index.get(name)
      if (k === undefined) {
        k = out.kinds.length
        out.kinds.push(name)
        index.set(name, k)
      }
      return k
    }
    let at = 0
    for (const c of parts) {
      const gid = c.gid as Int32Array
      const kind = c.kind && isDict(c.kind) ? c.kind : null
      const opcode = c.opcode as Int32Array
      const dictKind = kind ? kind.dict.map(kindOf) : []
      const opKind = req.opcodes.map(kindOf)
      out.gid.set(gid, at)
      out.lane.set(c.lane as Int32Array, at)
      for (let i = 0; i < gid.length; i++) {
        const k = kind ? kind.codes[i] : -1
        out.kind[at + i] = k >= 0 ? dictKind[k] : opKind[opcode[i]] ?? kindOf(`opcode ${opcode[i]}`)
      }
      at += gid.length
    }
    return out
  })()
  taskKinds = { key, value }
  return value
}

/** The task row of a gid in the gid-sorted rows, or -1. */
function rowOf(gids: Int32Array, gid: number): number {
  let lo = 0
  let hi = gids.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (gids[mid] < gid) lo = mid + 1
    else hi = mid
  }
  return lo < gids.length && gids[lo] === gid ? lo : -1
}

/** The owners grouped by (lane, kind) and by kind; programs and no owner stay as they are.
 * A task not in the trace goes to the kind group 'not in the trace' (lane -1). */
function groupOwners(owners: [number, number][], tk: TaskKinds): { laneKind: OwnerGroup[]; kind: OwnerGroup[] } {
  const NOT_IN = tk.kinds.length
  const kinds = [...tk.kinds, 'not in the trace']
  const byLaneKind = new Map<number, OwnerGroup>()
  const byKind = new Map<number, OwnerGroup & { perLane: Map<number, number> }>()
  const single: OwnerGroup[] = []
  for (const [owner, value] of owners) {
    if (owner < 0) {
      single.push({ owner, lane: -1, kind: '', value, tasks: 0, lanes: 0 })
      continue
    }
    const row = rowOf(tk.gid, owner)
    const lane = row >= 0 ? tk.lane[row] : -1
    const kind = row >= 0 ? tk.kind[row] : NOT_IN
    const key = (lane + 1) * (kinds.length + 1) + kind
    let g = byLaneKind.get(key)
    if (!g) byLaneKind.set(key, (g = { owner: null, lane, kind: kinds[kind], value: 0, tasks: 0, lanes: 1 }))
    g.value += value
    g.tasks++
    let h = byKind.get(kind)
    if (!h) byKind.set(kind, (h = { owner: null, lane: -1, kind: kinds[kind], value: 0, tasks: 0, lanes: 0, perLane: new Map() }))
    h.value += value
    h.tasks++
    h.perLane.set(lane, (h.perLane.get(lane) ?? 0) + value)
  }
  const kindGroups: OwnerGroup[] = [...byKind.values()].map(({ perLane, ...g }) => {
    let best = -Infinity
    for (const [lane, v] of perLane) if (v > best) { best = v; g.lane = lane }
    return { ...g, lanes: perLane.size }
  })
  const order = (gs: OwnerGroup[]) => gs.sort((x, y) => y.value - x.value)
  return { laneKind: order([...byLaneKind.values(), ...single]), kind: order([...kindGroups, ...single]) }
}

export async function attribute(req: AttributionRequest, read: ReadGroup, ranges: GroupRanges): Promise<Attribution> {
  const t0 = performance.now()
  const wanted = new Set(req.resources)
  const lo = Math.min(...req.resources)
  const hi = Math.max(...req.resources)
  const acc = new Map<number, number>()
  const add = (owner: number, v: number) => acc.set(owner, (acc.get(owner) ?? 0) + v)
  let usageGroups = 0
  let chargeGroups = 0
  const chargeCols = ['resource', 'start', 'end', 'cycles', 'amount', 'gid', 'program']
  const charges = async (g: number, take: (i: number, c: Record<string, Column>) => void) => {
    const c = await read('charges', req.charges, g, chargeCols)
    chargeGroups++
    const res = c.resource as Int32Array
    for (let i = 0; i < res.length; i++) if (res[i] >= lo && res[i] <= hi && wanted.has(res[i])) take(i, c)
  }
  const gidOf = (c: Record<string, Column>) => c.gid as Int32Array
  const progOf = (c: Record<string, Column>) => (c.program as Int32Array | undefined) ?? null

  if (req.t !== null) {
    // An instant: the charges with start <= t < end hold cycles / (end - start) lanes.
    const t = req.t
    for (let g = 0; g < req.blocks.length; g++) {
      const blk = req.blocks[g]
      if (blk.t0 > t || blk.maxEnd <= t) continue
      await charges(g, (i, c) => {
        const s = (c.start as Float64Array)[i]
        const e = (c.end as Float64Array)[i]
        if (s <= t && t < e) {
          const p = progOf(c)
          add(ownerOf(gidOf(c)[i], p ? p[i] : -1), (c.cycles as Int32Array)[i] / (e - s))
        }
      })
    }
  } else {
    // A range: the blocks inside it from usage, the edge blocks from their charges,
    // clipped (a charge's amount spread evenly over its span).
    const { a, b } = req
    const inside = new Set<number>()
    const edge: number[] = []
    req.blocks.forEach((blk, g) => {
      if (blk.t0 >= b || blk.maxEnd <= a) return
      if (req.usage && blk.t0 >= a && blk.maxEnd <= b) inside.add(g)
      else edge.push(g)
    })
    if (req.usage && inside.size) {
      const rr = await ranges('usage', req.usage, 'resource')
      for (let g = 0; g < rr.length; g++) {
        if (rr[g][1] < lo || rr[g][0] > hi) continue
        const c = await read('usage', req.usage, g, ['resource', 'block', 'gid', 'program', 'amount'])
        usageGroups++
        const res = c.resource as Int32Array
        const blk = c.block as Int32Array
        const gid = c.gid as Int32Array
        const prog = c.program as Int32Array
        const amt = c.amount as Float64Array
        for (let i = 0; i < res.length; i++) {
          if (res[i] < lo || res[i] > hi || !wanted.has(res[i]) || !inside.has(blk[i])) continue
          add(ownerOf(gid[i], prog[i]), amt[i])
        }
      }
    }
    for (const g of edge) {
      await charges(g, (i, c) => {
        const s = (c.start as Float64Array)[i]
        const e = (c.end as Float64Array)[i]
        const amt = (c.amount as Float64Array)[i]
        const part = e > s ? amt * Math.max(0, Math.min(e, b) - Math.max(s, a)) / (e - s) : s >= a && s < b ? amt : 0
        if (part > 0) {
          const p = progOf(c)
          add(ownerOf(gidOf(c)[i], p ? p[i] : -1), part)
        }
      })
    }
  }
  const entries = [...acc.entries()].filter(([, v]) => v > 0).sort((x, y) => y[1] - x[1])
  const tg = performance.now()
  const taskGroups = (await ranges('tasks', req.tasks, 'gid')).length
  const groups = groupOwners(entries, await readTaskKinds(req, read, taskGroups))
  const groupMs = performance.now() - tg
  return {
    owners: Int32Array.from(entries, ([k]) => k),
    values: Float64Array.from(entries, ([, v]) => v),
    total: entries.reduce((s, [, v]) => s + v, 0),
    ...groups,
    usageGroups, chargeGroups, ms: performance.now() - t0, groupMs,
  }
}
