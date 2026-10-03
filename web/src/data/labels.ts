// Task labels from the label field columns, in the manifest's label format.
import { isDict } from './columns'
import type { Trace } from './trace'

/** The task's label, or null if the dump has no label fields or a field is NULL. */
export function taskLabel(trace: Trace, task: number): string | null {
  const c = trace.facts.tasks.cols
  const fields = trace.manifest.label.fields
  if (fields.length === 0) return null
  let missing = false
  const s = trace.manifest.label.format.replace(/\{(\w+)\}/g, (_, name: string) => {
    const col = c[name]
    if (!col) { missing = true; return '' }
    if (isDict(col)) {
      const code = col.codes[task]
      if (code < 0) missing = true
      return code < 0 ? '' : col.dict[code]
    }
    const v = col[task]
    if ((col instanceof Int32Array && v === -1) || v !== v) missing = true
    return String(v)
  })
  return missing ? null : s
}
