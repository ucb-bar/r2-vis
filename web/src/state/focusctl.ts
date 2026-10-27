// The focus of the open trace (state/focus.ts) as a store: gestures set fixed parts, and
// one propagation pass derives the others. The fixed parts show at once; the derived ones
// follow as their queries return. Passes do not overlap: a gesture during a pass starts
// a new pass when the running one ends (the running one stops at its next edge).
import { EMPTY_FOCUS, fixedOf, itemKey, PART_NAMES, propagate, sameTime, type Focus, type FocusQueries, type PartName, type Parts } from './focus'
import { Store } from './store'

/** Where the last gesture came from (a Source area follows the focus unless it set it). */
export type FocusOrigin = 'source' | 'timeline' | 'instant' | 'bar' | 'other'

export class FocusControl {
  readonly state = new Store<Focus>(EMPTY_FOCUS)
  origin: FocusOrigin = 'other'
  private queries: FocusQueries | null = null
  private start: Focus = EMPTY_FOCUS
  private blocked: ReadonlySet<PartName> = new Set()
  private seq = 0
  private done = 0
  private running = false

  get(): Focus {
    return this.state.get()
  }

  /** A pass runs or is about to: the derived parts are not final yet. */
  get busy(): boolean {
    return this.running || (this.done !== this.seq && this.queries !== null)
  }

  subscribe(f: (v: Focus) => void): () => void {
    return this.state.subscribe(f)
  }

  /** The queries (again when the source maps change: the focus is derived again). */
  setQueries(q: FocusQueries): void {
    this.queries = q
    this.run(this.start)
  }

  /** A gesture: `parts` become the fixed parts; with `keep` (alt), the other fixed parts
   * stay. Every other part is cleared, then derived. */
  set(parts: Partial<Parts>, opts: { keep?: boolean; origin?: FocusOrigin } = {}): void {
    const cur = this.state.get()
    const base: Partial<Parts> = {}
    if (opts.keep) for (const k of cur.fixed) Object.assign(base, { [k]: cur[k] })
    const next = fixedOf({ ...base, ...parts })
    // the same fixed parts again (the first click of a double click): nothing to derive
    if (!this.blocked.size && sameFixed(next, this.start)) return
    this.origin = opts.origin ?? 'other'
    this.blocked = new Set()
    this.run(next)
  }

  /** Clears one part (× on its chip): the focus is derived again from the other fixed
   * parts; the cleared part stays empty until the next gesture. */
  clearPart(k: PartName): void {
    const cur = this.state.get()
    const parts: Partial<Parts> = {}
    for (const f of cur.fixed) if (f !== k) Object.assign(parts, { [f]: cur[f] })
    this.origin = 'bar'
    this.blocked = new Set([...this.blocked, k])
    this.run(fixedOf(parts))
  }

  /** Sets the fixed parts of an earlier focus again. */
  restore(f: Focus): void {
    const parts: Partial<Parts> = {}
    for (const k of f.fixed) Object.assign(parts, { [k]: f[k] })
    this.set(parts, { origin: 'other' })
  }

  clear(): void {
    if (this.state.get().fixed.size || this.state.get().pending.size) this.set({})
  }

  private run(start: Focus): void {
    this.start = start
    this.seq++
    this.state.set(start)
    void this.loop()
  }

  private async loop(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      while (this.done !== this.seq && this.queries) {
        const seq = this.seq
        this.done = seq
        const stale = () => seq !== this.seq
        await propagate(this.start, this.queries, (f) => { if (!stale()) this.state.set(f) }, stale, this.blocked)
      }
    } finally {
      this.running = false
    }
  }
}

/** Two foci with the same fixed parts (and the same values in them). */
function sameFixed(x: Focus, y: Focus): boolean {
  if (x.fixed.size !== y.fixed.size || [...x.fixed].some((k) => !y.fixed.has(k))) return false
  const list = <T>(a: readonly T[] | null, b: readonly T[] | null, key: (v: T) => unknown) =>
    a === b || (!!a && !!b && a.length === b.length && a.every((v, i) => key(v) === key(b[i])))
  return PART_NAMES.every((k) => {
    if (!x.fixed.has(k)) return true
    if (k === 'time') return sameTime(x.time, y.time)
    if (k === 'items') return list(x.items, y.items, itemKey)
    return list<number>(x[k], y[k], (v) => v)
  })
}
