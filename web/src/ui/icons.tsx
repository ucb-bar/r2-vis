// Icons of the area headers and the workspace tabs, in the ink color (currentColor).
import type { ReactElement } from 'react'

export type IconName = 'splitRow' | 'splitColumn' | 'mergeLeft' | 'mergeRight' | 'mergeUp' | 'mergeDown'
  | 'close' | 'maximize' | 'restore' | 'add' | 'reset'

const merge = (rot: number): ReactElement => (
  <g transform={`rotate(${rot} 8 8)`}>
    <rect x="2" y="3" width="12" height="10" rx="1" /><path d="M5 8h6M9 5.5L11.5 8 9 10.5" />
  </g>
)

const PATHS: Record<IconName, ReactElement> = {
  splitRow: <><rect x="2" y="3" width="12" height="10" rx="1" /><path d="M8 3v10" /></>,
  splitColumn: <><rect x="2" y="3" width="12" height="10" rx="1" /><path d="M2 8h12" /></>,
  mergeRight: merge(0),
  mergeDown: merge(90),
  mergeLeft: merge(180),
  mergeUp: merge(270),
  close: <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />,
  maximize: <path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" />,
  restore: <path d="M6 2.5V6H2.5M13.5 6H10V2.5M10 13.5V10h3.5M2.5 10H6v3.5" />,
  add: <path d="M8 3.5v9M3.5 8h9" />,
  reset: <><path d="M3 8a5 5 0 1 0 1.5-3.6" /><path d="M3 2.5v2.5h2.5" /></>,
}

export function Icon({ name, size = 14 }: { name: IconName; size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.4"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{PATHS[name]}</svg>
  )
}
