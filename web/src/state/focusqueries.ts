// The queries behind the focus edges (state/focus.ts) on an open trace: source items and
// tasks through the source links, and the occupants of resources in a worker (forward
// attribution, in the attribution scope). Also the span of task bars (a double click) and
// the scope's owner masks.
import type { Attribution, AttributionRequest, AttributionScope } from '../data/attribution'
import type { WorkerPool } from '../data/pool'
import type { Trace } from '../data/trace'
import { linkFor, parentSpawns, programIndex, taskRowOfGid, type LoadedMap } from '../source/links'
import type { FocusItem, FocusQueries, FocusTime } from './focus'

/** The worker that runs the charge queries (its task-kind cache is read once per trace). */
export const ATTRIBUTION_WORKER = 0

/** A task's bar in the timeline: issue (else invoke) to complete (else the end of the run). */
export function taskBar(trace: Trace, t: number): { a: number; b: number } {
  const c = trace.facts.tasks.cols
  const iss = (c.issue as Float64Array)[t]
  const a = iss === iss ? iss : (c.invoke as Float64Array)[t]
  const end = (c.complete as Float64Array)[t]
  return { a, b: end === end ? Math.max(end, a + 1) : trace.manifest.end_time }
}

/** The span of task bars: from the first start to the last end; null for no task. */
export function spanOf(trace: Trace, tasks: readonly number[]): FocusTime | null {
  if (!tasks.length) return null
  let a = Infinity
  let b = -Infinity
  for (const t of tasks) {
    const bar = taskBar(trace, t)
    if (bar.a < a) a = bar.a
    if (bar.b > b) b = bar.b
  }
  return { a, b: Math.max(b, a + 1) }
}

const scopes = new WeakMap<Trace, { scope: ReadonlySet<number>; masks: AttributionScope }>()

/** The owner masks of an attribution scope (node ids: their subtrees); null for none (the
 * whole device). Built once per scope. */
export function scopeMasks(trace: Trace, scope: ReadonlySet<number>): AttributionScope | null {
  if (!scope.size) return null
  const hit = scopes.get(trace)
  if (hit && hit.scope === scope) return hit.masks
  const nodes = trace.dims.nodes
  const inside = new Uint8Array(nodes.length)
  for (let n = 0; n < nodes.length; n++) {
    for (let a: number | null = n; a !== null && a !== undefined; a = nodes[a].parent as number | null) {
      if (scope.has(a)) { inside[n] = 1; break }
    }
  }
  const c = trace.facts.tasks.cols
  const gid = c.gid as Int32Array
  const lane = c.lane as Int32Array
  const gids = new Uint8Array(gid.length ? gid[gid.length - 1] + 1 : 0)
  for (let t = 0; t < gid.length; t++) {
    const node = trace.dims.lanes[lane[t]]?.node as number | undefined
    if (node !== undefined && inside[node]) gids[gid[t]] = 1
  }
  const nu = trace.facts.programs.cols.nu as Int32Array
  const programs = Uint8Array.from(nu, (n) => (inside[n] ? 1 : 0))
  const masks = { gids, programs }
  scopes.set(trace, { scope, masks })
  return masks
}

const blocksOf = (trace: Trace) => trace.manifest.charge_blocks.map((b) => ({ t0: b.t0, t1: b.t1, maxEnd: b.max_end }))

/** The queries; `scope` gives the attribution scope at the time of a query. */
export function focusQueries(trace: Trace, maps: LoadedMap[], pool: WorkerPool, scope: () => ReadonlySet<number>): FocusQueries {
  const link = linkFor(trace, maps)
  const files = trace.reader.files
  return {
    tasksOfItems(items: readonly FocusItem[]): number[] {
      const out = new Set<number>()
      for (const it of items) {
        const mi = maps.findIndex((m) => m.name === it.map)
        const pi = mi < 0 ? -1 : maps[mi].map.programs.findIndex((p) => p.program === it.program)
        if (pi < 0) continue
        const node = programIndex(maps[mi].map.programs[pi]).byId.get(it.id)
        if (node) for (const t of link.tasksOf({ mi, pi }, node)) out.add(t)
      }
      for (const t of parentSpawns(trace, [...out])) out.add(t)
      return [...out].sort((x, y) => x - y)
    },
    itemsOf(tasks: readonly number[]): FocusItem[] {
      return link.itemsOf(tasks).map(({ mp, node }) => ({ map: maps[mp.mi].name, program: maps[mp.mi].map.programs[mp.pi].program, id: node.id }))
    },
    async occupants(resources: readonly number[], time: FocusTime): Promise<number[]> {
      const charges = files.get('charges.parquet')
      const tasks = files.get('tasks.parquet')
      if (!charges || !tasks || !resources.length) return []
      const req: AttributionRequest = { usage: files.get('usage.parquet') ?? null, charges, resources: [...resources],
        t: 't' in time ? time.t : null, a: 't' in time ? 0 : time.a, b: 't' in time ? 0 : time.b,
        blocks: blocksOf(trace), tasks, opcodes: trace.dims.opcodes.map((o) => String(o.name)), classBase: trace.classBase,
        scope: scopeMasks(trace, scope()) }
      const res = await pool.compute<Attribution>({ op: 'attribute', req }, [], ATTRIBUTION_WORKER)
      const out: number[] = []
      for (const owner of res.owners) {
        if (owner < 0) continue  // a program or no owner
        const row = taskRowOfGid(trace, owner)
        if (row >= 0) out.push(row)
      }
      return out.sort((x, y) => x - y)
    },
  }
}
