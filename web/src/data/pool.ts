// A pool of workers (worker.ts). Requests go to the next free worker; larger requests are
// sent first.
import type { Column } from './parquet/decode'
import type { ComputeRequest, DecodeRequest, WorkerReply } from './worker'

export interface DecodeJob {
  name: string
  file: File
  group: number
  columns: string[] | null
  bytes: number
  indexResources?: number
}

export interface PoolStats {
  workerMs: number
  fallbackUnits: number
}

type Message = Omit<DecodeRequest, 'id'> | Omit<ComputeRequest, 'id'>
interface Queued { msg: Message; size: number; transfer: Transferable[]; resolve: (r: unknown) => void; reject: (e: Error) => void }

export class WorkerPool {
  private readonly workers: Worker[]
  private readonly idle: Worker[]
  private readonly queue: Queued[] = []
  private readonly pending = new Map<number, Queued>()
  private nextId = 0
  readonly stats: PoolStats = { workerMs: 0, fallbackUnits: 0 }

  constructor(size: number) {
    this.workers = Array.from({ length: size }, () => {
      const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
      w.onmessage = (e: MessageEvent<WorkerReply>) => this.done(w, e.data)
      return w
    })
    this.idle = [...this.workers]
  }

  get size(): number {
    return this.workers.length
  }

  decode(job: DecodeJob): Promise<Record<string, Column>> {
    const msg: Message = { op: 'decode', file: job.file, name: job.name, group: job.group, columns: job.columns,
      indexResources: job.indexResources }
    return this.submit(msg, job.bytes, []) as Promise<Record<string, Column>>
  }

  compute<T>(msg: Omit<ComputeRequest, 'id'>, transfer: Transferable[] = []): Promise<T> {
    return this.submit(msg, Infinity, transfer) as Promise<T>
  }

  /** Forgets cached footers (a new trace is opened). */
  reset(): void {
    for (const w of this.workers) w.postMessage({ op: 'reset' })
  }

  terminate(): void {
    for (const w of this.workers) w.terminate()
  }

  private submit(msg: Message, size: number, transfer: Transferable[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.queue.push({ msg, size, transfer, resolve, reject })
      this.queue.sort((a, b) => b.size - a.size)
      this.pump()
    })
  }

  private pump(): void {
    while (this.idle.length && this.queue.length) {
      const worker = this.idle.pop() as Worker
      const job = this.queue.shift() as Queued
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
