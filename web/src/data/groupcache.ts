// Decoded row groups of the charge and usage tables in the attribution worker (S13): kept
// by (table, row group), least recently used first out, at most GROUP_CACHE_BYTES of typed
// arrays. A group is decoded with every column asked of it so far (null: all its columns);
// the queries only read the columns (they never change them, and their results are new
// arrays), and a view's copy is made before it leaves the worker.
import { isDict, type Column } from './parquet/decode'

/** The most bytes of decoded columns kept. */
export const GROUP_CACHE_BYTES = 384 * 1024 * 1024

/** The tables whose groups are kept. */
export const CACHED_TABLES = new Set(['charges', 'usage'])

/** The bytes of a column: its typed array (a dict column: its codes and its strings). */
function columnBytes(c: Column): number {
  return isDict(c) ? c.codes.byteLength + c.dict.reduce((s, x) => s + 2 * x.length, 0) : c.byteLength
}

/** The asked set of a group decoded with all its columns. */
const ALL = '*'

interface Entry {
  cols: Record<string, Column>
  /** the columns asked of it (a column the file lacks is asked, not decoded) */
  asked: Set<string>
  bytes: number
}

export interface GroupCacheStats {
  entries: number
  bytes: number
  limit: number
  hits: number
  misses: number
  evictions: number
  /** groups kept from another worker's decode */
  seeds: number
}

export class GroupCache {
  private readonly entries = new Map<string, Entry>()  // insertion order = LRU order
  /** decodes running (two queries interleave at their awaits), and groups another worker
   * decodes for this one (claimed, seeded later): shared, not repeated. A claim that is
   * released resolves to null: the waiting queries then decode it themselves. */
  private readonly inflight = new Map<string, { asked: Set<string>; done: Promise<Record<string, Column> | null> }>()
  /** per claimed group: resolves its inflight promise (with the seeded columns, or null) */
  private readonly claims = new Map<string, (cols: Record<string, Column> | null) => void>()
  private bytes = 0
  private hits = 0
  private misses = 0
  private evictions = 0
  private seeds = 0
  /** bumped by clear(): a decode that started before is not kept */
  private epoch = 0
  private limit = GROUP_CACHE_BYTES

  /** A new cap (bytes; 0: no cache): the least recently used groups above it go. */
  setLimit(bytes: number): void {
    this.limit = bytes
    for (const k of [...this.entries.keys()]) {
      if (this.bytes <= this.limit) break
      this.drop(k)
      this.evictions++
    }
  }

  /** The columns of a group: from the cache when it holds them, else from `decode` (asked
   * for the columns asked before too), then kept. */
  async get(table: string, group: number, columns: string[] | null,
    decode: (columns: string[] | null) => Promise<Record<string, Column>>): Promise<Record<string, Column>> {
    const key = `${table}|${group}`
    const has = (asked: Set<string>) => asked.has(ALL) || (columns !== null && columns.every((c) => asked.has(c)))
    const hit = this.entries.get(key)
    if (hit && has(hit.asked)) {
      this.hits++
      this.entries.delete(key)
      this.entries.set(key, hit)
      return hit.cols
    }
    const running = this.inflight.get(key)
    if (running && has(running.asked)) {
      const cols = await running.done
      if (cols) {
        this.hits++
        return cols
      }
      return this.get(table, group, columns, decode)   // a claim released: decode here
    }
    this.misses++
    const asked = columns === null ? new Set([ALL]) : new Set([...(hit?.asked ?? []), ...(running?.asked ?? []), ...columns])
    const epoch = this.epoch
    const done = decode(asked.has(ALL) ? null : [...asked])
    this.inflight.set(key, { asked, done })
    let cols: Record<string, Column>
    try {
      cols = await done
    } finally {
      if (this.inflight.get(key)?.done === done) this.inflight.delete(key)
    }
    if (epoch === this.epoch) this.keep(key, cols, asked)
    return cols
  }

  /** Claims a whole group for a decode on another worker (a view's): false when this cache
   * holds it or decodes it already (the view then reads it here). Until seed or release,
   * the queries that ask for it wait. */
  claim(table: string, group: number): boolean {
    const key = `${table}|${group}`
    if (this.entries.get(key)?.asked.has(ALL) || this.inflight.has(key)) return false
    let resolve: (cols: Record<string, Column> | null) => void = () => {}
    const done = new Promise<Record<string, Column> | null>((r) => { resolve = r })
    this.inflight.set(key, { asked: new Set([ALL]), done })
    this.claims.set(key, resolve)
    return true
  }

  /** A claimed group, decoded by another worker (all its columns, as decoded): kept, and
   * given to the queries that wait for it. A seed without a claim (cleared since) is not kept. */
  seed(table: string, group: number, cols: Record<string, Column>): void {
    const key = `${table}|${group}`
    const resolve = this.claims.get(key)
    if (!resolve) return
    this.claims.delete(key)
    this.inflight.delete(key)
    this.seeds++
    this.keep(key, cols, new Set([ALL]))
    resolve(cols)
  }

  /** A claim whose decode failed: the waiting queries decode the group themselves. */
  release(table: string, group: number): void {
    const key = `${table}|${group}`
    const resolve = this.claims.get(key)
    if (!resolve) return
    this.claims.delete(key)
    this.inflight.delete(key)
    resolve(null)
  }

  private keep(key: string, cols: Record<string, Column>, asked: Set<string>): void {
    if (this.limit <= 0) return
    this.drop(key)
    const bytes = Object.values(cols).reduce((s, c) => s + columnBytes(c), 0)
    this.entries.set(key, { cols, asked, bytes })
    this.bytes += bytes
    // evict the least recently used, never the group just kept
    for (const k of this.entries.keys()) {
      if (this.bytes <= this.limit || k === key) break
      this.drop(k)
      this.evictions++
    }
  }

  private drop(key: string): void {
    const e = this.entries.get(key)
    if (!e) return
    this.bytes -= e.bytes
    this.entries.delete(key)
  }

  clear(): void {
    for (const resolve of this.claims.values()) resolve(null)
    this.claims.clear()
    this.entries.clear()
    this.inflight.clear()
    this.epoch++
    this.bytes = 0
    this.hits = this.misses = this.evictions = this.seeds = 0
  }

  stats(): GroupCacheStats {
    return { entries: this.entries.size, bytes: this.bytes, limit: this.limit, hits: this.hits, misses: this.misses, evictions: this.evictions, seeds: this.seeds }
  }
}
