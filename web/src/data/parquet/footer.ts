// Parquet footers and row-group byte ranges, read from a trace file by byte ranges.
import { parquetMetadata, type FileMetaData } from 'hyparquet'
import { readRange, type TraceFile } from '../tracefile'

/** Bytes read from the end of a file at first: most footers fit, so one read (one request
 * for a served file) gets the length and the footer. */
const TAIL_BYTES = 64 * 1024

export async function readFooter(file: TraceFile): Promise<FileMetaData> {
  const size = file.size
  const first = Math.max(0, size - TAIL_BYTES)
  const tailBuf = await readRange(file, first, size)
  const len = new DataView(tailBuf).getUint32(tailBuf.byteLength - 8, true)
  const start = size - 8 - len
  const footer = start >= first ? tailBuf.slice(start - first) : await readRange(file, start, size)
  // parquetMetadata expects the end of the file; give it footer + its length + magic.
  return parquetMetadata(footer)
}

/** [start, end) bytes of a row group in the file. */
export function rowGroupRange(meta: FileMetaData, group: number): [number, number] {
  let lo = Infinity
  let hi = 0
  for (const c of meta.row_groups[group].columns) {
    const md = c.meta_data
    if (!md) continue
    const start = Number(md.dictionary_page_offset ?? md.data_page_offset)
    lo = Math.min(lo, start)
    hi = Math.max(hi, start + Number(md.total_compressed_size))
  }
  return [lo, hi]
}
