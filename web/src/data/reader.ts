// The only interface of the views to the trace files: row groups and typed-array columns
// of a table (see columns.ts). Parquet stays inside data/parquet and the workers.
import { concatParts, type Column, type Table } from './columns'
import { readFooter } from './parquet/footer'
import type { FileMetaData } from 'hyparquet'
import { ATTRIBUTION_WORKER, type WorkerPool } from './pool'
import type { TraceFile } from './tracefile'

export interface RowGroupInfo {
  rows: number
  bytes: number
}

export class TraceReader {
  private readonly footers = new Map<string, Promise<FileMetaData>>()
  readonly files: Map<string, TraceFile>
  readonly pool: WorkerPool

  constructor(files: Map<string, TraceFile>, pool: WorkerPool) {
    this.files = files
    this.pool = pool
  }

  has(table: string): boolean {
    return this.files.has(`${table}.parquet`)
  }

  private file(table: string): TraceFile {
    const f = this.files.get(`${table}.parquet`)
    if (!f) throw new Error(`the trace has no ${table}.parquet`)
    return f
  }

  private footer(table: string): Promise<FileMetaData> {
    let f = this.footers.get(table)
    if (!f) {
      f = readFooter(this.file(table))
      this.footers.set(table, f)
    }
    return f
  }

  async rowGroups(table: string): Promise<RowGroupInfo[]> {
    const meta = await this.footer(table)
    return meta.row_groups.map((rg) => ({
      rows: Number(rg.num_rows),
      bytes: rg.columns.reduce((a, c) => a + Number(c.meta_data?.total_compressed_size ?? 0), 0),
    }))
  }

  async columnNames(table: string): Promise<string[]> {
    return (await this.footer(table)).schema.slice(1).map((s) => s.name)
  }

  /** All columns of one charges row group, with the per-resource index built in the
   * worker (columns __from, __to, __maxSpan). */
  async readChargeGroup(group: number, nResources: number, classBase?: Int32Array): Promise<Record<string, Column>> {
    const info = await this.rowGroups('charges')
    const job = { name: 'charges', file: this.file('charges'), group, columns: null, bytes: info[group].bytes,
      indexResources: nResources, classBase }
    // One fetch per group for the views and the attribution queries. When the attribution
    // worker's group cache holds the group (or decodes it), read it there; else claim it,
    // decode it on any worker (in parallel with the others) and seed that cache with a copy.
    // While claimed, a query that asks for the group waits for the seed instead of fetching.
    if (await this.pool.ask(ATTRIBUTION_WORKER, { op: 'claim', name: 'charges', group }) === 'held') {
      return this.pool.decode({ ...job, shared: ATTRIBUTION_WORKER })
    }
    try {
      const { cols, raw } = await this.pool.decode({ ...job, raw: true }) as unknown as { cols: Record<string, Column>; raw: Record<string, Column> }
      void this.pool.ask(ATTRIBUTION_WORKER, { op: 'seed', name: 'charges', group, cols: raw }, buffersOf(raw))
      return cols
    } catch (err) {
      void this.pool.ask(ATTRIBUTION_WORKER, { op: 'release', name: 'charges', group })
      throw err
    }
  }

  /** Columns (all if null) of the given row groups (all if omitted), concatenated. */
  async readColumns(table: string, columns: string[] | null, groups?: number[],
    onGroup?: () => void): Promise<Table> {
    const info = await this.rowGroups(table)
    const which = groups ?? info.map((_, g) => g)
    const file = this.file(table)
    const parts = await Promise.all(which.map((group) =>
      this.pool.decode({ name: table, file, group, columns, bytes: info[group].bytes }).then((cols) => {
        onGroup?.()
        return cols
      })))
    return concatParts(parts)
  }
}

/** The buffers of decoded columns (to transfer them). */
function buffersOf(cols: Record<string, Column>): ArrayBuffer[] {
  return Object.values(cols).map((c) => ('codes' in c && !ArrayBuffer.isView(c) ? c.codes.buffer : (c as ArrayBufferView).buffer) as ArrayBuffer)
}
