// Slow path: hyparquet for a row group that uses an encoding decode.ts does not handle.
// The values are converted to the column types of decode.ts.
import { parquetRead, type FileMetaData } from 'hyparquet'
import type { Column, Zstd } from './decode'

export async function decodeWithHyparquet(file: File, meta: FileMetaData, group: number,
  columns: Set<string> | null, zstd: Zstd): Promise<Record<string, Column>> {
  let rowStart = 0
  for (let g = 0; g < group; g++) rowStart += Number(meta.row_groups[g].num_rows)
  const rowEnd = rowStart + Number(meta.row_groups[group].num_rows)
  const types = new Map(meta.schema.slice(1).map((s) => [s.name, s.type]))
  const raw: Record<string, unknown[]> = {}
  const asyncFile = { byteLength: file.size, slice: (a: number, b?: number) => file.slice(a, b).arrayBuffer() }
  await parquetRead({
    file: asyncFile, metadata: meta, rowStart, rowEnd,
    columns: columns ? [...columns] : undefined,
    compressors: { ZSTD: (input: Uint8Array, length: number) => zstd(input, length) },
    onChunk: ({ columnName, columnData }) => {
      const list = (raw[columnName] ||= [])
      for (let i = 0; i < columnData.length; i++) list.push(columnData[i])
    },
  })
  const out: Record<string, Column> = {}
  for (const [name, values] of Object.entries(raw)) out[name] = convert(values, types.get(name))
  return out
}

function convert(values: unknown[], type: string | undefined): Column {
  const n = values.length
  switch (type) {
    case 'INT64':
    case 'DOUBLE': {
      const a = new Float64Array(n)
      for (let i = 0; i < n; i++) a[i] = values[i] == null ? NaN : Number(values[i])
      return a
    }
    case 'INT32': {
      const a = new Int32Array(n)
      for (let i = 0; i < n; i++) a[i] = values[i] == null ? -1 : Number(values[i])
      return a
    }
    case 'FLOAT': {
      const a = new Float32Array(n)
      for (let i = 0; i < n; i++) a[i] = values[i] == null ? NaN : Number(values[i])
      return a
    }
    case 'BOOLEAN': {
      const a = new Uint8Array(n)
      for (let i = 0; i < n; i++) a[i] = values[i] == null ? 255 : values[i] ? 1 : 0
      return a
    }
    default: {
      const dict: string[] = []
      const index = new Map<string, number>()
      const codes = new Int32Array(n)
      for (let i = 0; i < n; i++) {
        const v = values[i]
        if (v == null) { codes[i] = -1; continue }
        const s = String(v)
        let c = index.get(s)
        if (c === undefined) { c = dict.length; dict.push(s); index.set(s, c) }
        codes[i] = c
      }
      return { kind: 'dict', codes, dict }
    }
  }
}
