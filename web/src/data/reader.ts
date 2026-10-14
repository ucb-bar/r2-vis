// The only interface of the views to the trace files: row groups and typed-array columns
// of a table (see columns.ts). Parquet stays inside data/parquet and the workers.
import { concatParts, type Column, type Table } from './columns'
import { readFooter } from './parquet/footer'
import type { FileMetaData } from 'hyparquet'
import type { WorkerPool } from './pool'

export interface RowGroupInfo {
  rows: number
  bytes: number
}

export class TraceReader {
  private readonly footers = new Map<string, Promise<FileMetaData>>()
  readonly files: Map<string, File>
  readonly pool: WorkerPool

  constructor(files: Map<string, File>, pool: WorkerPool) {
    this.files = files
    this.pool = pool
  }

  has(table: string): boolean {
    return this.files.has(`${table}.parquet`)
  }

  private file(table: string): File {
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
    return this.pool.decode({ name: 'charges', file: this.file('charges'), group, columns: null,
      bytes: info[group].bytes, indexResources: nResources, classBase })
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
