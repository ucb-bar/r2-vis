// The files of a .r2t directory: from the folder picker or a drop (local), or served by
// r2t-serve (by URL, tracefile.ts).
import { localFile, type TraceFile } from './tracefile'

export interface TraceFiles {
  name: string
  files: Map<string, TraceFile>
  /** a served trace: its URL (kept in the page's #trace= fragment) */
  url?: string
}

/** Subdirectories of a trace whose files are read (format 1.10: the source maps; gzip from 1.11). */
const SUBDIRS = ['sources']

/** From <input type="file" webkitdirectory>: the files next to manifest.json, and those of
 * its subdirectories in SUBDIRS (named "sources/NAME.json.gz"). */
export function fromFileList(list: FileList): TraceFiles {
  const all = Array.from(list)
  const manifest = all.find((f) => baseName(pathOf(f)) === 'manifest.json')
  if (!manifest) throw new Error('the folder has no manifest.json (pick the .r2t folder)')
  const dir = dirName(pathOf(manifest))
  const files = new Map<string, TraceFile>()
  for (const f of all) {
    const d = dirName(pathOf(f))
    if (d === dir) files.set(baseName(pathOf(f)), localFile(f))
    else if (SUBDIRS.some((s) => d === (dir ? `${dir}/${s}` : s))) files.set(`${baseName(d)}/${baseName(pathOf(f))}`, localFile(f))
  }
  return { name: baseName(dir) || 'trace', files }
}

/** From a drop: one dropped directory, or the files of a trace dropped together. */
export async function fromDrop(dt: DataTransfer): Promise<TraceFiles> {
  const entries = Array.from(dt.items)
    .map((item) => item.webkitGetAsEntry())
    .filter((e): e is FileSystemEntry => e !== null)
  const dirs = entries.filter((e) => e.isDirectory) as FileSystemDirectoryEntry[]
  if (dirs.length === 1 && entries.length === 1) {
    const files = new Map<string, TraceFile>()
    for (const entry of await readAll(dirs[0])) {
      if (entry.isFile) files.set(entry.name, localFile(await fileOf(entry as FileSystemFileEntry)))
      else if (entry.isDirectory && SUBDIRS.includes(entry.name)) {
        for (const sub of await readAll(entry as FileSystemDirectoryEntry)) {
          if (sub.isFile) files.set(`${entry.name}/${sub.name}`, localFile(await fileOf(sub as FileSystemFileEntry)))
        }
      }
    }
    if (!files.has('manifest.json')) throw new Error(`${dirs[0].name} has no manifest.json`)
    return { name: dirs[0].name, files }
  }
  const files = new Map<string, TraceFile>()
  for (const f of Array.from(dt.files)) files.set(f.name, localFile(f))
  if (!files.has('manifest.json')) throw new Error('drop the .r2t folder (or all of its files)')
  return { name: 'trace', files }
}

function pathOf(f: File): string {
  return (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name
}

function baseName(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1)
}

function dirName(p: string): string {
  const i = p.lastIndexOf('/')
  return i < 0 ? '' : p.slice(0, i)
}

function readAll(dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = dir.createReader()
  const out: FileSystemEntry[] = []
  return new Promise((resolve, reject) => {
    const next = () => reader.readEntries((batch) => {
      if (batch.length === 0) resolve(out)
      else { out.push(...batch); next() }
    }, reject)
    next()
  })
}

function fileOf(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject))
}
