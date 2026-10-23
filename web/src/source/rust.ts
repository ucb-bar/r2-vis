// A small Rust tokenizer for the Source view: comments, doc comments, strings, chars,
// numbers, keywords, attributes, macros and type names, per line. No library.

export type TokenKind = 'text' | 'comment' | 'doc' | 'string' | 'char' | 'number' | 'keyword' | 'attr' | 'macro' | 'type' | 'lifetime'

export interface Token { kind: TokenKind; text: string }

const KEYWORDS = new Set([
  'as', 'async', 'await', 'break', 'const', 'continue', 'crate', 'dyn', 'else', 'enum', 'extern', 'false', 'fn',
  'for', 'if', 'impl', 'in', 'let', 'loop', 'match', 'mod', 'move', 'mut', 'pub', 'ref', 'return', 'self', 'Self',
  'static', 'struct', 'super', 'trait', 'true', 'type', 'unsafe', 'use', 'where', 'while', 'union',
])

/** The tokens of a source text, one list per line (block comments and strings that span
 * lines are split at the line ends). */
export function tokenizeRust(text: string): Token[][] {
  const lines: Token[][] = [[]]
  const push = (kind: TokenKind, s: string) => {
    const parts = s.split('\n')
    parts.forEach((p, k) => {
      if (k > 0) lines.push([])
      if (p) lines[lines.length - 1].push({ kind, text: p })
    })
  }
  const n = text.length
  let i = 0
  const isIdStart = (c: string) => /[A-Za-z_]/.test(c)
  const isId = (c: string) => /[A-Za-z0-9_]/.test(c)
  while (i < n) {
    const c = text[i]
    const c2 = text.slice(i, i + 2)
    if (c2 === '//') {
      let j = text.indexOf('\n', i)
      if (j < 0) j = n
      const s = text.slice(i, j)
      push(/^\/\/[/!](?!\/)/.test(s) ? 'doc' : 'comment', s)
      i = j
    } else if (c2 === '/*') {
      let depth = 1
      let j = i + 2
      while (j < n && depth > 0) {
        if (text.startsWith('/*', j)) { depth++; j += 2 } else if (text.startsWith('*/', j)) { depth--; j += 2 } else j++
      }
      const s = text.slice(i, j)
      push(/^\/\*[*!](?!\/)/.test(s) ? 'doc' : 'comment', s)
      i = j
    } else if (c === '"' || ((c === 'b' || c === 'c') && text[i + 1] === '"')) {
      let j = c === '"' ? i + 1 : i + 2
      while (j < n && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      push('string', text.slice(i, Math.min(n, j + 1)))
      i = j + 1
    } else if (/^b?r#*"/.test(text.slice(i, i + 8)) && (c === 'r' || c === 'b')) {
      const m = /^b?r(#*)"/.exec(text.slice(i, i + 8)) as RegExpExecArray
      const close = `"${m[1]}`
      const j = text.indexOf(close, i + m[0].length)
      const end = j < 0 ? n : j + close.length
      push('string', text.slice(i, end))
      i = end
    } else if (c === '\'') {
      // a char ('a', '\n', '\u{1F600}') or a lifetime ('a)
      const m = /^'(\\(u\{[0-9a-fA-F]+\}|x[0-9a-fA-F]{2}|.)|[^\\'])'/.exec(text.slice(i, i + 12))
      if (m) { push('char', m[0]); i += m[0].length } else {
        const l = /^'[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i))
        const s = l ? l[0] : c
        push(l ? 'lifetime' : 'text', s)
        i += s.length
      }
    } else if (c === '#' && (text[i + 1] === '[' || (text[i + 1] === '!' && text[i + 2] === '['))) {
      let depth = 0
      let j = i
      while (j < n) {
        if (text[j] === '[') depth++
        else if (text[j] === ']') { depth--; if (depth === 0) { j++; break } }
        j++
      }
      push('attr', text.slice(i, j))
      i = j
    } else if (/[0-9]/.test(c)) {
      const m = /^(0x[0-9a-fA-F_]+|0o[0-7_]+|0b[01_]+|[0-9][0-9_]*(\.[0-9][0-9_]*)?([eE][+-]?[0-9_]+)?)([iu](8|16|32|64|128|size)|f32|f64)?/.exec(text.slice(i))
      const s = m ? m[0] : c
      push('number', s)
      i += s.length
    } else if (isIdStart(c)) {
      let j = i + 1
      while (j < n && isId(text[j])) j++
      const word = text.slice(i, j)
      if (text[j] === '!' && text[j + 1] !== '=') { push('macro', `${word}!`); i = j + 1; continue }
      push(KEYWORDS.has(word) ? 'keyword' : /^[A-Z][A-Za-z0-9]*[a-z]/.test(word) ? 'type' : 'text', word)
      i = j
    } else {
      let j = i + 1
      while (j < n && !/[A-Za-z0-9_'"#/\n]/.test(text[j])) j++
      if (text[i] === '\n') j = i + 1
      push('text', text.slice(i, j))
      i = j
    }
  }
  return lines
}
