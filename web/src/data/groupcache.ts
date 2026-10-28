// Decoded row groups of the charge and usage tables in the attribution worker (S13): kept
// by (table, row group), least recently used first out, at most GROUP_CACHE_BYTES of typed
// arrays. A group is decoded with every column asked of it so far; the queries only read
// the columns (they never change them, and their results are new arrays).
import { isDict, type Column } from './parquet/decode'

/** The most bytes of decoded columns kept. */
export const GROUP_CACHE_BYTES = 384 * 1024 * 1024

/** The tables whose groups are kept. */
export const CACHED_TABLES = new Set(['charges', 'usage'])

/** The bytes of a column: its typed array (a dict column: its codes and its strings). */
function columnBytes(c: Column): number {
  return isDict(c) ? c.codes.byteLength + c.dict.reduce((s, x) => s + 2 * x.length, 0) : c.byteLength
}

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
}

export class GroupCache {
  private readonly entries = new Map<string, Entry>()  // insertion order = LRU order
  /** decodes running (two queries interleave at their awaits): shared, not repeated */
  private readonly inflight = new Map<string, { asked: Set<string>; done: Promise<Record<string, Column>> }>()
  private bytes = 0
  private hits = 0
  private misses = 0
  private evictions = 0
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
  async get(table: string, group: number, columns: string[],
    decode: (columns: string[]) => Promise<Record<string, Column>>): Promise<Record<string, Column>> {
    const key = `${table}|${group}`
    const hit = this.entries.get(key)
    if (hit && columns.every((c) => hit.asked.has(c))) {
      this.hits++
      this.entries.delete(key)
      this.entries.set(key, hit)
      return hit.cols
    }
    const running = this.inflight.get(key)
    if (running && columns.every((c) => running.asked.has(c))) {
      this.hits++
      return running.done
    }
    this.misses++
    const asked = new Set([...(hit?.asked ?? []), ...(running?.asked ?? []), ...columns])
    const epoch = this.epoch
    const done = decode([...asked])
    this.inflight.set(key, { asked, done })
    let cols: Record<string, Column>
    try {
      cols = await done
    } finally {
      if (this.inflight.get(key)?.done === done) this.inflight.delete(key)
    }
    if (this.limit <= 0 || epoch !== this.epoch) return cols
    this.drop(key)
    const bytes = Object.values(cols).reduce((s, c) => s + columnBytes(c), 0)
    this.entries.set(key, { cols, asked, bytes })
    this.bytes += bytes
    // evict the least recently used, never the group just read
    for (const k of this.entries.keys()) {
      if (this.bytes <= this.limit || k === key) break
      this.drop(k)
      this.evictions++
    }
    return cols
  }

  private drop(key: string): void {
    const e = this.entries.get(key)
    if (!e) return
    this.bytes -= e.bytes
    this.entries.delete(key)
  }

  clear(): void {
    this.entries.clear()
    this.inflight.clear()
    this.epoch++
    this.bytes = 0
    this.hits = this.misses = this.evictions = 0
  }

  stats(): GroupCacheStats {
    return { entries: this.entries.size, bytes: this.bytes, limit: this.limit, hits: this.hits, misses: this.misses, evictions: this.evictions }
  }
}
