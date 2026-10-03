// Thrift compact protocol: a generic struct reader ({fieldId: value}) for Parquet page
// headers. Integers are Numbers (exact below 2^53).

export type ThriftValue = number | boolean | Uint8Array | ThriftValue[] | ThriftStruct
export interface ThriftStruct {
  [field: number]: ThriftValue
}

export class ByteReader {
  readonly bytes: Uint8Array
  readonly view: DataView
  offset: number

  constructor(bytes: Uint8Array, offset = 0) {
    this.bytes = bytes
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    this.offset = offset
  }

  varint(): number {
    let result = 0
    let mul = 1
    let byte: number
    do {
      byte = this.bytes[this.offset++]
      result += (byte & 0x7f) * mul
      mul *= 128
    } while (byte & 0x80)
    return result
  }

  zigzag(): number {
    const u = this.varint()
    return u % 2 === 0 ? u / 2 : -(u + 1) / 2
  }
}

export function readStruct(r: ByteReader): ThriftStruct {
  const out: ThriftStruct = {}
  let last = 0
  for (;;) {
    const byte = r.bytes[r.offset++]
    const type = byte & 0x0f
    if (type === 0) return out
    const delta = byte >> 4
    const id = delta ? last + delta : r.zigzag()
    last = id
    out[id] = readValue(r, type)
  }
}

function readValue(r: ByteReader, type: number): ThriftValue {
  switch (type) {
    case 1:
      return true
    case 2:
      return false
    case 3:
      return r.bytes[r.offset++]
    case 4:
    case 5:
    case 6:
      return r.zigzag()
    case 7: {
      const v = r.view.getFloat64(r.offset, true)
      r.offset += 8
      return v
    }
    case 8: {
      const n = r.varint()
      const s = r.bytes.subarray(r.offset, r.offset + n)
      r.offset += n
      return s
    }
    case 9:
    case 10: {
      const header = r.bytes[r.offset++]
      let n = header >> 4
      const elem = header & 0x0f
      if (n === 15) n = r.varint()
      const list: ThriftValue[] = []
      for (let i = 0; i < n; i++) {
        list.push(elem === 1 || elem === 2 ? r.bytes[r.offset++] === 1 : readValue(r, elem))
      }
      return list
    }
    case 12:
      return readStruct(r)
    default:
      throw new Error(`thrift: unsupported type ${type}`)
  }
}
