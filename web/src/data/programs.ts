// Program runs per Neutrino (node id): start, end (end of run if it did not return), name.
import { isDict, type DictColumn } from './columns'
import type { Trace } from './trace'

export interface ProgramSpan {
  start: number
  end: number
  name: string
}

export function programSpans(trace: Trace): Map<number, ProgramSpan[]> {
  const out = new Map<number, ProgramSpan[]>()
  const pc = trace.facts.programs.cols
  const pname = pc.name as DictColumn
  for (let i = 0; i < trace.facts.programs.rows; i++) {
    const nu = (pc.nu as Int32Array)[i]
    const end = (pc.end as Float64Array)[i]
    if (!out.has(nu)) out.set(nu, [])
    out.get(nu)?.push({
      start: (pc.start as Float64Array)[i], end: end === end ? end : trace.manifest.end_time,
      name: isDict(pname) && pname.codes[i] >= 0 ? pname.dict[pname.codes[i]] : '',
    })
  }
  return out
}
