// The number formats of the tooltips (views-design 8): cycles with digit grouping for
// times, k/M for counts and durations, % with at most two significant digits, rates as
// `256 / 512 B/cycle`.

/** A time in cycles: 10,534,500. */
export function cycles(t: number): string {
  return Math.round(t).toLocaleString('en-US')
}

/** A count or a duration: 274, 7.7k, 39k, 1.5M. */
export function count(n: number): string {
  const a = Math.abs(n)
  if (a < 1e3) return String(Math.round(n))
  const [v, s] = a < 1e6 ? [n / 1e3, 'k'] : a < 1e9 ? [n / 1e6, 'M'] : [n / 1e9, 'G']
  return `${Math.abs(v) < 10 ? v.toFixed(1).replace(/\.0$/, '') : Math.round(v)}${s}`
}

/** A fraction as a percentage, at most two significant digits: 0.4 %, 12 %, 100 %; a
 * value above 0 and below 0.1 % is `<0.1 %`. */
export function pct(frac: number): string {
  const p = 100 * frac
  const a = Math.abs(p)
  if (a === 0) return '0 %'
  if (a < 0.1) return '<0.1 %'
  if (a >= 9.95) return `${Math.round(p)} %`
  return `${p.toFixed(1)} %`
}

/** A rate or another measured value: three significant digits, k/M above 10,000; a value
 * above 0 and below 0.01 is `<0.01`. */
export function num(v: number): string {
  const a = Math.abs(v)
  if (a >= 1e4) return count(v)
  if (a > 0 && a < 0.01) return '<0.01'
  if (a >= 100 || a === 0) return String(Math.round(v))
  if (a >= 10) return v.toFixed(1).replace(/\.0$/, '')
  return v.toFixed(2).replace(/\.?0+$/, '')
}

/** A rate against a ceiling: `256 / 512 B/cycle`; without a ceiling `256 B/cycle`. */
export function rate(v: number, cap: number | null, unit: string): string {
  return cap ? `${num(v)} / ${num(cap)} ${unit}/cycle` : `${num(v)} ${unit}/cycle`
}

/** A path without the leading `root.` (every path starts there); `root` itself is ''. */
export function short(path: string): string {
  return path === 'root' ? '' : path.startsWith('root.') ? path.slice(5) : path
}

/** A dotted path split into its last part and the parent path (shown muted). */
export function splitPath(path: string): { name: string; parent: string } {
  const i = path.lastIndexOf('.')
  return i < 0 ? { name: path, parent: '' } : { name: path.slice(i + 1), parent: short(path.slice(0, i)) }
}

/** `name` without the prefix `of` and its dot, when `name` starts with it. */
export function relative(name: string, of: string): string {
  return name.startsWith(`${of}.`) ? name.slice(of.length + 1) : name
}

/** A time range [a, b): its ends in k or M cycles with the decimals that the span needs
 * (one significant digit of the span), and the span: `[10.53M, 10.54M) · 10k cycles`. */
export function span(a: number, b: number): string {
  const [unit, s] = b >= 1e6 ? [1e6, 'M'] : b >= 1e3 ? [1e3, 'k'] : [1, '']
  const width = (b - a) / unit
  const d = width > 0 ? Math.max(0, Math.min(6, -Math.floor(Math.log10(width)))) : 0
  const end = (t: number) => (t === 0 ? '0' : `${(t / unit).toFixed(d)}${s}`)
  return `[${end(a)}, ${end(b)}) · ${count(b - a)} cycles`
}

/** An amount in its unit: bytes in KB/MB/GB (1024), else k/M with the unit: 64 KB,
 * 2.1M MAC, 40 instr. */
export function amount(v: number, unit: string): string {
  if (unit === 'B') {
    const a = Math.abs(v)
    const [x, u] = a < 1024 ? [v, 'B'] : a < 1024 ** 2 ? [v / 1024, 'KB'] : a < 1024 ** 3 ? [v / 1024 ** 2, 'MB'] : [v / 1024 ** 3, 'GB']
    const n = u === 'B' ? String(Math.round(x)) : Math.abs(x) < 10 ? x.toFixed(1).replace(/\.0$/, '') : String(Math.round(x))
    return `${n} ${u}`
  }
  return `${count(v)} ${unit}`
}
