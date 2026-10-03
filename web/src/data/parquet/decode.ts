// Column decoder for the Parquet files that r2t-convert writes (trace-format Section 2):
// data pages v1 or v2, zstd or uncompressed, encodings PLAIN, RLE_DICTIONARY,
// DELTA_BINARY_PACKED and BYTE_STREAM_SPLIT, flat columns (required or optional).
//
// Output per physical type, with the null value used:
//   INT64, DOUBLE -> Float64Array (NaN)    INT32 -> Int32Array (-1)
//   FLOAT -> Float32Array (NaN)            BOOLEAN -> Uint8Array (255)
//   BYTE_ARRAY -> DictColumn {codes (-1), dict}
// INT64 values are Numbers: exact below 2^53 (times, ids, amounts; not the raw label).
// The decode loops use Number arithmetic, not BigInt. Each loop is written for one array
// type, so that V8 keeps it monomorphic. Anything else throws Unsupported, and the caller
// falls back to hyparquet.

import type { ColumnChunk, FileMetaData, SchemaElement } from 'hyparquet'
import { ByteReader, readStruct, type ThriftStruct } from './thrift'

export interface DictColumn {
  kind: 'dict'
  codes: Int32Array
  dict: string[]
}
export type NumColumn = Float64Array | Int32Array | Float32Array | Uint8Array
export type Column = NumColumn | DictColumn
export type Zstd = (input: Uint8Array, size: number) => Uint8Array

export class Unsupported extends Error {}

const PAGE_DATA = 0
const PAGE_DICTIONARY = 2
const PAGE_DATA_V2 = 3
const ENC_PLAIN = 0
const ENC_PLAIN_DICTIONARY = 2
const ENC_RLE = 3
const ENC_DELTA = 5
const ENC_RLE_DICTIONARY = 8
const ENC_BSS = 9
const TEXT = new TextDecoder()

export function isDict(c: Column): c is DictColumn {
  return (c as DictColumn).kind === 'dict'
}

/** Decodes the selected columns (all if null) of one row group. `buffer` holds the file
 * bytes from offset `base` on (at least the row group's range). */
export function decodeRowGroup(buffer: ArrayBuffer, base: number, meta: FileMetaData,
  group: number, columns: Set<string> | null, zstd: Zstd): Record<string, Column> {
  const rg = meta.row_groups[group]
  const rows = Number(rg.num_rows)
  const elements = meta.schema.slice(1)
  const out: Record<string, Column> = {}
  rg.columns.forEach((chunk, i) => {
    const el = elements[i]
    if (columns && !columns.has(el.name)) return
    out[el.name] = decodeColumn(buffer, base, chunk, el, rows, zstd)
  })
  return out
}

interface Page {
  values: ByteReader      // positioned at the values
  end: number             // end of the values in values.bytes
  count: number           // values in the page (nulls included)
  defs: Uint8Array | null // 1 = present, per value; null if required
  present: number
  encoding: number
}

function decodeColumn(buffer: ArrayBuffer, base: number, chunk: ColumnChunk, el: SchemaElement,
  rows: number, zstd: Zstd): Column {
  const md = chunk.meta_data
  if (!md) throw new Unsupported('column chunk without metadata')
  const start = Number(md.dictionary_page_offset ?? md.data_page_offset)
  const bytes = new Uint8Array(buffer, start - base, Number(md.total_compressed_size))
  const optional = el.repetition_type === 'OPTIONAL'
  if (el.repetition_type === 'REPEATED') throw new Unsupported('repeated column')
  const sink = makeSink(md.type, rows)
  const r = new ByteReader(bytes)
  let row = 0
  while (row < rows && r.offset < bytes.length) {
    const header = readStruct(r)
    const type = header[1] as number
    const usize = header[2] as number
    const csize = header[3] as number
    const body = bytes.subarray(r.offset, r.offset + csize)
    r.offset += csize
    if (type === PAGE_DICTIONARY) {
      const dh = header[7] as ThriftStruct
      const page = uncompress(body, usize, md.codec, zstd)
      sink.dictionary(new ByteReader(page), dh[1] as number)
    } else if (type === PAGE_DATA || type === PAGE_DATA_V2) {
      const page = type === PAGE_DATA
        ? dataPageV1(header[5] as ThriftStruct, body, usize, md.codec, optional, zstd)
        : dataPageV2(header[8] as ThriftStruct, body, usize, md.codec, optional, zstd)
      sink.page(page, row)
      row += page.count
    } else {
      throw new Unsupported(`page type ${type}`)
    }
  }
  return sink.result()
}

function uncompress(body: Uint8Array, usize: number, codec: string, zstd: Zstd): Uint8Array {
  if (codec === 'UNCOMPRESSED') return body
  if (codec === 'ZSTD') return zstd(body, usize)
  throw new Unsupported(`codec ${codec}`)
}

function dataPageV1(dh: ThriftStruct, body: Uint8Array, usize: number, codec: string,
  optional: boolean, zstd: Zstd): Page {
  const page = uncompress(body, usize, codec, zstd)
  const count = dh[1] as number
  const r = new ByteReader(page)
  let defs: Uint8Array | null = null
  let present = count
  if (optional) {
    const len = r.view.getUint32(r.offset, true)
    r.offset += 4
    defs = new Uint8Array(count)
    rleHybrid(r, r.offset + len, 1, count, defs)
    present = countOnes(defs)
  }
  return { values: r, end: page.length, count, defs, present, encoding: dh[2] as number }
}

function dataPageV2(dh: ThriftStruct, body: Uint8Array, usize: number, codec: string,
  optional: boolean, zstd: Zstd): Page {
  const count = dh[1] as number
  const nulls = dh[2] as number
  const defLen = dh[5] as number
  const repLen = dh[6] as number
  const compressed = dh[7] !== false
  let defs: Uint8Array | null = null
  if (optional && defLen > 0) {
    defs = new Uint8Array(count)
    const lr = new ByteReader(body, repLen)
    rleHybrid(lr, repLen + defLen, 1, count, defs)
  }
  const rest = body.subarray(repLen + defLen)
  const values = compressed ? uncompress(rest, usize - repLen - defLen, codec, zstd) : rest
  return { values: new ByteReader(values), end: values.length, count, defs,
    present: count - nulls, encoding: dh[4] as number }
}

function countOnes(defs: Uint8Array): number {
  let n = 0
  for (let i = 0; i < defs.length; i++) n += defs[i]
  return n
}

// ---- sinks: one per output array type -----------------------------------------------

interface Sink {
  dictionary(r: ByteReader, n: number): void
  page(p: Page, row: number): void
  result(): Column
}

function makeSink(type: string, rows: number): Sink {
  switch (type) {
    case 'INT64': return new Int64Sink(rows)
    case 'INT32': return new Int32Sink(rows)
    case 'FLOAT': return new Float32Sink(rows)
    case 'DOUBLE': return new Float64Sink(rows)
    case 'BOOLEAN': return new BoolSink(rows)
    case 'BYTE_ARRAY': return new StringSink(rows)
    default: throw new Unsupported(`physical type ${type}`)
  }
}

class Int64Sink implements Sink {
  out: Float64Array
  dict: Float64Array | null = null
  constructor(rows: number) { this.out = new Float64Array(rows) }
  dictionary(r: ByteReader, n: number): void {
    this.dict = new Float64Array(n)
    plainInt64(r, n, this.dict, 0)
  }
  page(p: Page, row: number): void {
    const dense = p.defs ? new Float64Array(p.present) : this.out.subarray(row, row + p.count)
    const r = p.values
    if (p.encoding === ENC_DELTA) deltaFloat64(r, dense)
    else if (p.encoding === ENC_PLAIN) plainInt64(r, p.present, dense, 0)
    else if (isDictEncoding(p.encoding)) dictFloat64(r, p.end, p.present, this.dict, dense)
    else throw new Unsupported(`INT64 encoding ${p.encoding}`)
    if (p.defs) scatterFloat64(dense, p.defs, this.out, row)
  }
  result(): Column { return this.out }
}

class Float64Sink implements Sink {
  out: Float64Array
  dict: Float64Array | null = null
  constructor(rows: number) { this.out = new Float64Array(rows) }
  dictionary(r: ByteReader, n: number): void {
    this.dict = new Float64Array(n)
    for (let i = 0; i < n; i++) this.dict[i] = r.view.getFloat64(r.offset + 8 * i, true)
  }
  page(p: Page, row: number): void {
    const dense = p.defs ? new Float64Array(p.present) : this.out.subarray(row, row + p.count)
    const r = p.values
    if (p.encoding === ENC_PLAIN) {
      for (let i = 0; i < dense.length; i++) dense[i] = r.view.getFloat64(r.offset + 8 * i, true)
    } else if (p.encoding === ENC_BSS) {
      byteStreamSplit(r, dense.length, 8, new Uint8Array(dense.buffer, dense.byteOffset, dense.byteLength))
    } else if (isDictEncoding(p.encoding)) dictFloat64(r, p.end, p.present, this.dict, dense)
    else throw new Unsupported(`DOUBLE encoding ${p.encoding}`)
    if (p.defs) scatterFloat64(dense, p.defs, this.out, row)
  }
  result(): Column { return this.out }
}

class Int32Sink implements Sink {
  out: Int32Array
  dict: Int32Array | null = null
  constructor(rows: number) { this.out = new Int32Array(rows) }
  dictionary(r: ByteReader, n: number): void {
    this.dict = new Int32Array(n)
    for (let i = 0; i < n; i++) this.dict[i] = r.view.getInt32(r.offset + 4 * i, true)
  }
  page(p: Page, row: number): void {
    const dense = p.defs ? new Int32Array(p.present) : this.out.subarray(row, row + p.count)
    const r = p.values
    if (p.encoding === ENC_DELTA) deltaInt32(r, dense)
    else if (p.encoding === ENC_PLAIN) {
      for (let i = 0; i < dense.length; i++) dense[i] = r.view.getInt32(r.offset + 4 * i, true)
    } else if (isDictEncoding(p.encoding)) {
      const idx = dictIndices(r, p.end, p.present)
      const d = this.dict
      if (!d) throw new Unsupported('dictionary page missing')
      for (let i = 0; i < idx.length; i++) dense[i] = d[idx[i]]
    } else throw new Unsupported(`INT32 encoding ${p.encoding}`)
    if (p.defs) {
      const out = this.out
      for (let i = 0, j = 0; i < p.count; i++) out[row + i] = p.defs[i] ? dense[j++] : -1
    }
  }
  result(): Column { return this.out }
}

class Float32Sink implements Sink {
  out: Float32Array
  dict: Float32Array | null = null
  constructor(rows: number) { this.out = new Float32Array(rows) }
  dictionary(r: ByteReader, n: number): void {
    this.dict = new Float32Array(n)
    for (let i = 0; i < n; i++) this.dict[i] = r.view.getFloat32(r.offset + 4 * i, true)
  }
  page(p: Page, row: number): void {
    const dense = p.defs ? new Float32Array(p.present) : this.out.subarray(row, row + p.count)
    const r = p.values
    if (p.encoding === ENC_BSS) {
      byteStreamSplit(r, dense.length, 4, new Uint8Array(dense.buffer, dense.byteOffset, dense.byteLength))
    } else if (p.encoding === ENC_PLAIN) {
      for (let i = 0; i < dense.length; i++) dense[i] = r.view.getFloat32(r.offset + 4 * i, true)
    } else if (isDictEncoding(p.encoding)) {
      const idx = dictIndices(r, p.end, p.present)
      const d = this.dict
      if (!d) throw new Unsupported('dictionary page missing')
      for (let i = 0; i < idx.length; i++) dense[i] = d[idx[i]]
    } else throw new Unsupported(`FLOAT encoding ${p.encoding}`)
    if (p.defs) {
      const out = this.out
      for (let i = 0, j = 0; i < p.count; i++) out[row + i] = p.defs[i] ? dense[j++] : NaN
    }
  }
  result(): Column { return this.out }
}

class BoolSink implements Sink {
  out: Uint8Array
  constructor(rows: number) { this.out = new Uint8Array(rows) }
  dictionary(): void { throw new Unsupported('BOOLEAN dictionary') }
  page(p: Page, row: number): void {
    const dense = new Uint8Array(p.present)
    const r = p.values
    if (p.encoding === ENC_PLAIN) {
      for (let i = 0; i < dense.length; i++) dense[i] = (r.bytes[r.offset + (i >> 3)] >> (i & 7)) & 1
    } else if (p.encoding === ENC_RLE) {
      r.offset += 4  // length prefix
      rleHybrid(r, p.end, 1, dense.length, dense)
    } else throw new Unsupported(`BOOLEAN encoding ${p.encoding}`)
    const out = this.out
    if (p.defs) for (let i = 0, j = 0; i < p.count; i++) out[row + i] = p.defs[i] ? dense[j++] : 255
    else out.set(dense, row)
  }
  result(): Column { return this.out }
}

class StringSink implements Sink {
  codes: Int32Array
  dict: string[] = []
  index = new Map<string, number>()
  pageDict: Int32Array | null = null  // dictionary page entry -> code
  constructor(rows: number) { this.codes = new Int32Array(rows) }
  intern(s: string): number {
    let code = this.index.get(s)
    if (code === undefined) {
      code = this.dict.length
      this.dict.push(s)
      this.index.set(s, code)
    }
    return code
  }
  readString(r: ByteReader): string {
    const len = r.view.getUint32(r.offset, true)
    const s = TEXT.decode(r.bytes.subarray(r.offset + 4, r.offset + 4 + len))
    r.offset += 4 + len
    return s
  }
  dictionary(r: ByteReader, n: number): void {
    this.pageDict = new Int32Array(n)
    for (let i = 0; i < n; i++) this.pageDict[i] = this.intern(this.readString(r))
  }
  page(p: Page, row: number): void {
    const dense = new Int32Array(p.present)
    const r = p.values
    if (isDictEncoding(p.encoding)) {
      const idx = dictIndices(r, p.end, p.present)
      const d = this.pageDict
      if (!d) throw new Unsupported('dictionary page missing')
      for (let i = 0; i < idx.length; i++) dense[i] = d[idx[i]]
    } else if (p.encoding === ENC_PLAIN) {
      for (let i = 0; i < dense.length; i++) dense[i] = this.intern(this.readString(r))
    } else throw new Unsupported(`BYTE_ARRAY encoding ${p.encoding}`)
    const out = this.codes
    if (p.defs) for (let i = 0, j = 0; i < p.count; i++) out[row + i] = p.defs[i] ? dense[j++] : -1
    else out.set(dense, row)
  }
  result(): Column { return { kind: 'dict', codes: this.codes, dict: this.dict } }
}

function isDictEncoding(e: number): boolean {
  return e === ENC_RLE_DICTIONARY || e === ENC_PLAIN_DICTIONARY
}

// ---- encodings ------------------------------------------------------------------------

function scatterFloat64(dense: Float64Array, defs: Uint8Array, out: Float64Array, row: number): void {
  for (let i = 0, j = 0; i < defs.length; i++) out[row + i] = defs[i] ? dense[j++] : NaN
}

function plainInt64(r: ByteReader, n: number, out: Float64Array, at: number): void {
  const v = r.view
  for (let i = 0; i < n; i++) {
    const o = r.offset + 8 * i
    out[at + i] = v.getUint32(o, true) + v.getInt32(o + 4, true) * 4294967296
  }
}

function dictIndices(r: ByteReader, end: number, n: number): Int32Array {
  const width = r.bytes[r.offset++]
  const idx = new Int32Array(n)
  rleHybrid(r, end, width, n, idx)
  return idx
}

function dictFloat64(r: ByteReader, end: number, n: number, dict: Float64Array | null,
  out: Float64Array): void {
  if (!dict) throw new Unsupported('dictionary page missing')
  const idx = dictIndices(r, end, n)
  for (let i = 0; i < n; i++) out[i] = dict[idx[i]]
}

/** RLE / bit-packed hybrid (bit width <= 24) into a Uint8Array or Int32Array. */
function rleHybrid(r: ByteReader, end: number, width: number, count: number,
  out: Uint8Array | Int32Array): void {
  const b = r.bytes
  const valueBytes = (width + 7) >> 3
  const mask = width === 32 ? -1 : (1 << width) - 1
  let i = 0
  while (i < count && r.offset < end) {
    const header = r.varint()
    if ((header & 1) === 0) {
      const n = header >>> 1
      let v = 0
      for (let k = 0; k < valueBytes; k++) v |= b[r.offset++] << (8 * k)
      out.fill(v, i, Math.min(count, i + n))
      i += n
    } else {
      const n = (header >>> 1) * 8
      let acc = 0
      let bits = 0
      for (let k = 0; k < n; k++) {
        while (bits < width) {
          acc |= b[r.offset++] << bits
          bits += 8
        }
        if (i < count) out[i] = acc & mask
        i++
        acc >>>= width
        bits -= width
      }
    }
  }
}

/** BYTE_STREAM_SPLIT: stream k holds byte k of every value. */
function byteStreamSplit(r: ByteReader, n: number, width: number, out: Uint8Array): void {
  const b = r.bytes
  const base = r.offset
  for (let k = 0; k < width; k++) {
    const s = base + k * n
    for (let i = 0; i < n; i++) out[i * width + k] = b[s + i]
  }
  r.offset += n * width
}

const POW2 = Array.from({ length: 54 }, (_, i) => 2 ** i)

/** Unsigned w-bit value at bit `pos` (w <= 45, exact in a Number). */
function bitsWide(b: Uint8Array, pos: number, w: number): number {
  let i = pos >>> 3
  const off = pos & 7
  let v = b[i++] >>> off
  let got = 8 - off
  while (got < w) {
    v += b[i++] * POW2[got]
    got += 8
  }
  return v % POW2[w]
}

/** Unsigned w-bit value at bit `pos` for any w <= 64, through BigInt (rare). */
function bitsBig(b: Uint8Array, pos: number, w: number): number {
  let v = 0n
  for (let k = 0; k < w; k++) {
    const p = pos + k
    if ((b[p >>> 3] >> (p & 7)) & 1) v |= 1n << BigInt(k)
  }
  return Number(v)
}

/** DELTA_BINARY_PACKED into a Float64Array (INT64 values as Numbers). */
function deltaFloat64(r: ByteReader, out: Float64Array): void {
  const blockSize = r.varint()
  const miniblocks = r.varint()
  const total = r.varint()
  let value = r.zigzag()
  if (total === 0) return
  out[0] = value
  let k = 1
  const per = blockSize / miniblocks
  const widths = new Uint8Array(miniblocks)
  const b = r.bytes
  while (k < total) {
    const minDelta = r.zigzag()
    for (let i = 0; i < miniblocks; i++) widths[i] = b[r.offset++]
    for (let m = 0; m < miniblocks && k < total; m++) {
      const w = widths[m]
      const start = r.offset
      if (w === 0) {
        for (let j = 0; j < per && k < total; j++) { value += minDelta; out[k++] = value }
      } else if (w <= 24) {
        const mask = (1 << w) - 1
        let acc = 0
        let bits = 0
        let o = start
        for (let j = 0; j < per && k < total; j++) {
          while (bits < w) { acc |= b[o++] << bits; bits += 8 }
          value += minDelta + (acc & mask)
          out[k++] = value
          acc >>>= w
          bits -= w
        }
      } else {
        const read = w <= 45 ? bitsWide : bitsBig
        for (let j = 0, pos = start * 8; j < per && k < total; j++, pos += w) {
          value += minDelta + read(b, pos, w)
          out[k++] = value
        }
      }
      r.offset = start + (per * w) / 8
    }
  }
}

/** DELTA_BINARY_PACKED into an Int32Array (wrapping 32-bit arithmetic). */
function deltaInt32(r: ByteReader, out: Int32Array): void {
  const blockSize = r.varint()
  const miniblocks = r.varint()
  const total = r.varint()
  let value = r.zigzag() | 0
  if (total === 0) return
  out[0] = value
  let k = 1
  const per = blockSize / miniblocks
  const widths = new Uint8Array(miniblocks)
  const b = r.bytes
  while (k < total) {
    const minDelta = r.zigzag() | 0
    for (let i = 0; i < miniblocks; i++) widths[i] = b[r.offset++]
    for (let m = 0; m < miniblocks && k < total; m++) {
      const w = widths[m]
      const start = r.offset
      if (w === 0) {
        for (let j = 0; j < per && k < total; j++) { value = (value + minDelta) | 0; out[k++] = value }
      } else if (w <= 24) {
        const mask = (1 << w) - 1
        let acc = 0
        let bits = 0
        let o = start
        for (let j = 0; j < per && k < total; j++) {
          while (bits < w) { acc |= b[o++] << bits; bits += 8 }
          value = (value + minDelta + (acc & mask)) | 0
          out[k++] = value
          acc >>>= w
          bits -= w
        }
      } else {
        for (let j = 0, pos = start * 8; j < per && k < total; j++, pos += w) {
          value = (value + minDelta + bitsWide(b, pos, w)) | 0
          out[k++] = value
        }
      }
      r.offset = start + (per * w) / 8
    }
  }
}
