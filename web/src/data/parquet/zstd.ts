// zstd decompression through zstddec (the zstd reference decoder compiled to wasm),
// about 10x faster than a JavaScript decoder on the r2t pages.
import { ZSTDDecoder } from 'zstddec'
import type { Zstd } from './decode'

let ready: Promise<Zstd> | null = null

export function zstdDecoder(): Promise<Zstd> {
  if (!ready) {
    const decoder = new ZSTDDecoder()
    ready = decoder.init().then(() => (input: Uint8Array, size: number) => decoder.decode(input, size))
  }
  return ready
}
