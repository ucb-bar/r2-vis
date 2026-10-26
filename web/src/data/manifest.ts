// manifest.json of a processed trace (trace-format Section 3).

export interface ChargeBlock {
  group: number
  t0: number
  t1: number
  max_end: number
  rows: number
}

export interface LabelField {
  name: string
  shift: number
  bits: number
  enum?: string[]
}

export interface Filters {
  nodes: string[] | null
  records: string[] | null
  types?: string[] | null
  window: [number, number] | null
  partial: boolean
}

export interface Manifest {
  format: string
  version: [number, number]
  run: Record<string, unknown>
  source: {
    raw_version: [number, number]
    converter_commit: string | null
    complete: boolean
    filters?: Filters
    dangling?: Record<string, number>
    absent_records?: string[]
  }
  end_time: number
  label: { fields: LabelField[]; format: string }
  /** bin b covers [origin + b * width, ...); origin from format 1.4 (before: 0) */
  bins: { width: number; count: number; origin?: number }
  charge_block_span: number
  charge_blocks: ChargeBlock[]
  tables: Record<string, { rows: number; description: string; columns: Record<string, string> }>
  /** format 1.10: the source maps in the trace (sources/NAME.json) whose programs ran */
  sources?: { file: string; from?: string; programs?: string[] }[]
}

export function parseManifest(text: string): Manifest {
  const m = JSON.parse(text) as Manifest
  if (m.format !== 'r2t') throw new Error(`manifest.json: format is ${m.format}, not r2t`)
  if (m.version?.[0] !== 1) throw new Error(`manifest.json: r2t version ${m.version} is not supported`)
  return m
}
