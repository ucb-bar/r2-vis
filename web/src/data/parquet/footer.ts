// Parquet footers and row-group byte ranges, read from a File by slices.
import { parquetMetadata, type FileMetaData } from 'hyparquet'

export async function readFooter(file: Blob): Promise<FileMetaData> {
  const size = file.size
  const tail = new DataView(await file.slice(size - 8).arrayBuffer())
  const len = tail.getUint32(0, true)
  const start = size - 8 - len
  const footer = await file.slice(start).arrayBuffer()
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
