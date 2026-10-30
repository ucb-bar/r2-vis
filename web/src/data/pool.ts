// A pool of workers (worker.ts). Requests go to the next free worker; larger requests are
// sent first. A pinned request waits for its own worker (a worker that keeps a cache).
import type { Column } from './parquet/decode'
import type { ComputeRequest, ControlRequest, DecodeRequest, WorkerReply } from './worker'
import type { TraceFile } from './tracefile'

/** The worker that runs the attribution queries and keeps the decoded charge and usage
 * groups (data/groupcache.ts). A charge group of the views is decoded on any worker and then
 * given to it (seeded), or read through it when it holds the group: one fetch per group. */
export const ATTRIBUTION_WORKER = 0

export interface DecodeJob {
  name: string
  file: TraceFile
  group: number
  columns: string[] | null
  bytes: number
  indexResources?: number
  classBase?: Int32Array
  /** decode on this worker (an index), through its group cache */
  shared?: number
  /** also reply with a copy of the group as decoded (before the charges index), to seed
   * the attribution worker's cache */
  raw?: boolean
}

export interface PoolStats {
  workerMs: number
  fallbackUnits: number
}

type Message = Omit<DecodeRequest, 'id'> | Omit<ComputeRequest, 'id'>
interface Queued { msg: Message; size: number; transfer: Transferable[]; pin: Worker | null; resolve: (r: unknown) => void; reject: (e: Error) => void }

/** A request without its id, per variant of the union. */
type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never

export class WorkerPool {
  private readonly workers: Worker[]
  private readonly idle: Worker[]
  private readonly queue: Queued[] = []
  private readonly pending = new Map<number, Queued>()
  /** control requests (sent at once, not queued: they do not occupy the worker) */
  private readonly asked = new Map<number, (r: unknown) => void>()
  private nextId = 0
  readonly stats: PoolStats = { workerMs: 0, fallbackUnits: 0 }

  constructor(size: number) {
    this.workers = Array.from({ length: size }, () => {
      const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
      w.onmessage = (e: MessageEvent<WorkerReply>) => {
        if (e.data.ctl) {
          this.asked.get(e.data.id)?.(e.data.result)
          this.asked.delete(e.data.id)
        } else this.done(w, e.data)
      }
      return w
    })
    this.idle = [...this.workers]
  }

  get size(): number {
    return this.workers.length
  }

  decode(job: DecodeJob): Promise<Record<string, Column>> {
    const msg: Message = { op: 'decode', file: job.file, name: job.name, group: job.group, columns: job.columns,
      indexResources: job.indexResources, classBase: job.classBase, shared: job.shared !== undefined, raw: job.raw }
    const pin = job.shared === undefined ? null : this.workers[job.shared % this.workers.length]
    return this.submit(msg, job.bytes, [], pin) as Promise<Record<string, Column>>
  }

  /** A compute request; `pin` (a worker index) sends it to that worker only. */
  compute<T>(msg: WithoutId<ComputeRequest>, transfer: Transferable[] = [], pin: number | null = null): Promise<T> {
    const worker = pin === null ? null : this.workers[pin % this.workers.length]
    return this.submit(msg, Infinity, transfer, worker) as Promise<T>
  }

  /** A control request to one worker, sent at once (not queued behind its jobs; the worker
   * answers between the awaits of a running job). */
  ask(worker: number, msg: ControlRequest, transfer: Transferable[] = []): Promise<unknown> {
    const id = this.nextId++
    return new Promise((resolve) => {
      this.asked.set(id, resolve)
      this.workers[worker % this.workers.length].postMessage({ ...msg, id }, transfer)
    })
  }

  /** Forgets cached footers (a new trace is opened). */
  reset(): void {
    for (const w of this.workers) w.postMessage({ op: 'reset' })
  }

  terminate(): void {
    for (const w of this.workers) w.terminate()
  }

  private submit(msg: Message, size: number, transfer: Transferable[], pin: Worker | null = null): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.queue.push({ msg, size, transfer, pin, resolve, reject })
      this.queue.sort((a, b) => b.size - a.size)
      this.pump()
    })
  }

  private pump(): void {
    for (let q = 0; q < this.queue.length && this.idle.length;) {
      const job = this.queue[q]
      const w = job.pin ? this.idle.indexOf(job.pin) : this.idle.length - 1
      if (w < 0) { q++; continue }
      const worker = this.idle.splice(w, 1)[0]
      this.queue.splice(q, 1)
      const id = this.nextId++
      this.pending.set(id, job)
      worker.postMessage({ ...job.msg, id }, job.transfer)
    }
  }

  private done(worker: Worker, reply: WorkerReply): void {
    const job = this.pending.get(reply.id)
    this.pending.delete(reply.id)
    this.idle.push(worker)
    if (job) {
      if (reply.error) job.reject(new Error(reply.error))
      else {
        this.stats.workerMs += reply.ms ?? 0
        if (reply.fallback) this.stats.fallbackUnits++
        job.resolve(reply.result)
      }
    }
    this.pump()
  }
}

/** Workers: `?workers=N` in the URL, else the cores minus one, between 2 and 8. */
export function defaultPoolSize(): number {
  const asked = Number(new URLSearchParams(location.search).get('workers'))
  if (asked >= 1) return Math.min(32, Math.floor(asked))
  const cores = navigator.hardwareConcurrency || 4
  return Math.max(2, Math.min(8, cores - 1))
}
