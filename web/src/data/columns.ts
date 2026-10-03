// Column tables in memory: typed arrays per column (see parquet/decode.ts for the types
// and null values).
import { isDict, type Column, type DictColumn } from './parquet/decode'

export type { Column, DictColumn }
export { isDict }

export interface Table {
  rows: number
  cols: Record<string, Column>
}

/** Concatenates the row-group pieces of one table (dictionaries are merged). */
export function concatParts(parts: Record<string, Column>[]): Table {
  if (parts.length === 0) return { rows: 0, cols: {} }
  const cols: Record<string, Column> = {}
  for (const name of Object.keys(parts[0])) {
    const pieces = parts.map((p) => p[name])
    cols[name] = pieces.length === 1 ? pieces[0] : concatColumn(pieces)
  }
  const first = Object.values(cols)[0]
  return { rows: first ? columnLength(first) : 0, cols }
}

export function columnLength(c: Column): number {
  return isDict(c) ? c.codes.length : c.length
}

function concatColumn(pieces: Column[]): Column {
  if (isDict(pieces[0])) return concatDict(pieces as DictColumn[])
  const typed = pieces as Exclude<Column, DictColumn>[]
  const n = typed.reduce((a, p) => a + p.length, 0)
  const Ctor = typed[0].constructor as new (n: number) => Exclude<Column, DictColumn>
  const out = new Ctor(n)
  let o = 0
  for (const p of typed) {
    out.set(p as never, o)
    o += p.length
  }
  return out
}

function concatDict(pieces: DictColumn[]): DictColumn {
  const dict: string[] = []
  const index = new Map<string, number>()
  const n = pieces.reduce((a, p) => a + p.codes.length, 0)
  const codes = new Int32Array(n)
  let o = 0
  for (const p of pieces) {
    const remap = p.dict.map((s) => {
      let c = index.get(s)
      if (c === undefined) {
        c = dict.length
        dict.push(s)
        index.set(s, c)
      }
      return c
    })
    for (let i = 0; i < p.codes.length; i++) codes[o + i] = p.codes[i] < 0 ? -1 : remap[p.codes[i]]
    o += p.codes.length
  }
  return { kind: 'dict', codes, dict }
}

/** Rows of a small table as objects (dimension tables). */
export function toRows(t: Table): Record<string, number | string | null>[] {
  const names = Object.keys(t.cols)
  const rows: Record<string, number | string | null>[] = []
  for (let i = 0; i < t.rows; i++) {
    const row: Record<string, number | string | null> = {}
    for (const name of names) {
      const c = t.cols[name]
      if (isDict(c)) row[name] = c.codes[i] < 0 ? null : c.dict[c.codes[i]]
      else {
        const v = c[i]
        const isNull = c instanceof Int32Array ? v === -1 : c instanceof Uint8Array ? v === 255 : Number.isNaN(v)
        row[name] = isNull ? null : v
      }
    }
    rows.push(row)
  }
  return rows
}
