// The design tokens as values, for canvas code (CSS components use the variables).

export interface Theme {
  page: string
  surface: string
  surfaceRaised: string
  inkOnLight: string
  inkOnDark: string
  ink: string
  inkSecondary: string
  inkMuted: string
  grid: string
  axis: string
  border: string
  hover: string
  accent: string
  accentInk: string
  accentArea: string
  /** the selection (the focus): outlines and lines, and area shading */
  select: string
  selectArea: string
  series: string[]
  seriesOther: string
  seq: string[]
  /** line colors by slot (colors.lineSlots): global-0..4, local-0..1, control-0..4, tensor, vector, scalar */
  lines: Record<string, string>
  fontSans: string
  fontMono: string
  fontSizeXs: number
  fontSizeS: number
  space: number[]
  radiusS: number
}

export function readTheme(el: Element = document.documentElement): Theme {
  const css = getComputedStyle(el)
  const v = (name: string) => css.getPropertyValue(name).trim()
  const px = (name: string) => parseFloat(v(name)) || 0
  return {
    page: v('--color-page'),
    surface: v('--color-surface'),
    surfaceRaised: v('--color-surface-raised'),
    inkOnLight: v('--color-ink-on-light'),
    inkOnDark: v('--color-ink-on-dark'),
    ink: v('--color-ink'),
    inkSecondary: v('--color-ink-secondary'),
    inkMuted: v('--color-ink-muted'),
    grid: v('--color-grid'),
    axis: v('--color-axis'),
    border: v('--color-border'),
    hover: v('--color-hover'),
    accent: v('--color-accent'),
    accentInk: v('--color-accent-ink'),
    accentArea: v('--color-accent-area'),
    select: v('--color-select'),
    selectArea: v('--color-select-area'),
    series: Array.from({ length: 8 }, (_, i) => v(`--series-${i + 1}`)),
    seriesOther: v('--series-other'),
    seq: Array.from({ length: 7 }, (_, i) => v(`--seq-${i}`)),
    lines: Object.fromEntries([
      ...[0, 1, 2, 3, 4].map((i) => `global-${i}`), 'local-0', 'local-1',
      ...[0, 1, 2, 3, 4].map((i) => `control-${i}`), 'tensor', 'vector', 'scalar',
    ].map((k) => [k, v(`--line-${k}`)])),
    fontSans: v('--font-sans'),
    fontMono: v('--font-mono'),
    fontSizeXs: px('--font-size-xs'),
    fontSizeS: px('--font-size-s'),
    space: [0, 1, 2, 3, 4, 5, 6, 7].map((i) => (i === 0 ? 0 : px(`--space-${i}`))),
    radiusS: px('--radius-s'),
  }
}

/** Re-reads the tokens when the color scheme changes. */
export function onThemeChange(cb: () => void): () => void {
  const mq = matchMedia('(prefers-color-scheme: dark)')
  const obs = new MutationObserver(cb)
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  mq.addEventListener('change', cb)
  return () => { obs.disconnect(); mq.removeEventListener('change', cb) }
}
