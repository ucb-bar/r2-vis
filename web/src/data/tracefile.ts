// A file of a trace: local (a File from the folder picker or a drop) or served by r2t-serve
// (a URL, read by byte range). Plain data, so that the workers get it in a message; the
// main thread and the workers read it through readRange and readText.

export type TraceFile =
  | { kind: 'local'; name: string; size: number; blob: Blob }
  | { kind: 'url'; name: string; size: number; url: string }

export function localFile(f: File): TraceFile {
  return { kind: 'local', name: f.name, size: f.size, blob: f }
}

/** An identity of the file's content (for caches in the workers). */
export function fileKey(f: TraceFile): string {
  return f.kind === 'url' ? f.url : `${f.name}|${f.size}|${(f.blob as File).lastModified ?? 0}`
}

/** A fetch that cannot reach the server (a TypeError): the message to show. */
export function unreachable(url: string): string {
  const origin = (() => { try { return new URL(url).origin } catch { return url } })()
  return `Cannot reach ${origin}: allow local network access for this site, or check that r2t-serve runs and its port is forwarded.`
}

async function get(url: string, init?: RequestInit): Promise<Response> {
  let res: Response
  try {
    res = await fetch(url, init)
  } catch (err) {
    if (err instanceof TypeError) throw new Error(unreachable(url))
    throw err
  }
  return res
}

/** A served file up to this size is read whole once (one request) and kept in this thread. */
const WHOLE_BYTES = 2 * 1024 * 1024
const whole = new Map<string, Promise<ArrayBuffer>>()

/** Bytes [lo, hi) of a file. */
export async function readRange(f: TraceFile, lo: number, hi: number): Promise<ArrayBuffer> {
  if (hi <= lo) return new ArrayBuffer(0)
  if (f.kind === 'local') return f.blob.slice(lo, hi).arrayBuffer()
  if (f.size <= WHOLE_BYTES) {
    let p = whole.get(f.url)
    if (!p) {
      p = fetchRange(f, 0, f.size)
      whole.set(f.url, p)
      p.catch(() => whole.delete(f.url))
    }
    return (await p).slice(lo, hi)
  }
  return fetchRange(f, lo, hi)
}

/** Forgets the files read whole (another trace is opened). */
export function resetWhole(): void {
  whole.clear()
}

async function fetchRange(f: TraceFile & { kind: 'url' }, lo: number, hi: number): Promise<ArrayBuffer> {
  const res = await get(f.url, { headers: { Range: `bytes=${lo}-${hi - 1}` } })
  if (res.status !== 206 && res.status !== 200) throw new Error(`${f.name}: HTTP ${res.status} for bytes ${lo}-${hi - 1}`)
  const buf = await res.arrayBuffer()
  // A server that ignores Range sends the whole file (200).
  if (res.status === 200 && buf.byteLength === f.size) return buf.slice(lo, hi)
  if (buf.byteLength !== hi - lo) throw new Error(`${f.name}: ${buf.byteLength} bytes for a range of ${hi - lo}`)
  return buf
}

/** The whole file as text; gzip data is unpacked (blobText). */
export async function readText(f: TraceFile): Promise<string> {
  if (f.kind === 'local') return blobText(f.blob)
  const res = await get(f.url)
  if (!res.ok) throw new Error(`${f.name}: HTTP ${res.status}`)
  return blobText(await res.blob())
}

/** The text of a blob. Gzip data (a source map NAME.json.gz, format 1.11) is unpacked: known
 * by its first bytes, not by the name, so that bytes a server already unpacked (with
 * Content-Encoding) are not unpacked twice. */
export async function blobText(b: Blob): Promise<string> {
  const head = new Uint8Array(await b.slice(0, 2).arrayBuffer())
  if (head[0] !== 0x1f || head[1] !== 0x8b) return b.text()
  return new Response(b.stream().pipeThrough(new DecompressionStream('gzip'))).text()
}

// ---- r2t-serve ---------------------------------------------------------------------------------

export interface ServedTrace { name: string; path: string; files: Record<string, number> }

/** A server URL as typed or from #trace=: the base (…/TOKEN/) and the trace name, if the
 * URL names one (…/TOKEN/NAME/). */
export function parseServerUrl(input: string): { base: string; trace: string | null } {
  const u = new URL(input.trim())
  const segs = u.pathname.split('/').filter(Boolean)
  if (segs[segs.length - 1] === 'index.json') segs.pop()
  if (!segs.length) throw new Error(`${input}: no token in the URL (r2t-serve prints the links)`)
  return { base: `${u.origin}/${segs[0]}/`, trace: segs[1] ? decodeURIComponent(segs[1]) : null }
}

/** The traces that a server lists (index.json). */
export async function fetchIndex(base: string): Promise<ServedTrace[]> {
  const res = await get(`${base}index.json`)
  if (res.status === 404) throw new Error(`${base}index.json not found: the token is wrong, or r2t-serve restarted with a new token.`)
  if (!res.ok) throw new Error(`${base}index.json: HTTP ${res.status}`)
  const json = (await res.json()) as { traces?: ServedTrace[] }
  return json.traces ?? []
}

/** The URL of a served trace (what #trace= holds). */
export function traceUrl(base: string, name: string): string {
  return `${base}${encodeURIComponent(name)}/`
}

/** The files of a served trace, read by URL; the sizes come from index.json. */
export function servedFiles(base: string, t: ServedTrace): Map<string, TraceFile> {
  const files = new Map<string, TraceFile>()
  for (const [name, size] of Object.entries(t.files)) {
    // a file of a subdirectory ("sources/NAME.json") keeps its slash
    files.set(name, { kind: 'url', name, size, url: `${traceUrl(base, t.name)}${name.split('/').map(encodeURIComponent).join('/')}` })
  }
  return files
}
