// One lexical scanner for SQL, shared by the statement splitter, the query
// router, the agent's read-only gate and the browser's hover/completion
// context (web/src/monaco/sqlcontext.ts imports it from here, like the JSON
// contract in schema-types.ts). It recognises exactly the constructs every
// consumer previously re-implemented — with subtle differences — so a keyword
// can never match inside a literal or comment again:
//
// - whitespace
// - `--` line comments (span excludes the terminating newline)
// - nested `/* */` block comments
// - single-quoted strings with `''` escapes; backslashes escape inside
//   E'…'/U&'…' (a standalone prefix only) and inside every string when
//   `standard_conforming_strings` is off
// - double-quoted identifiers with `""` escapes
// - dollar-quoted bodies ($$…$$, $tag$…$tag$), only after a token boundary
// - bare-word identifiers and punctuation/digit runs
//
// Feature-specific classification stays with the consumers: this module says
// *what* the text is made of, never what it means.

export type SqlLexemeKind =
  | 'whitespace'
  | 'lineComment'
  | 'blockComment'
  | 'string'
  | 'dollar'
  | 'ident'
  | 'punct'

export interface SqlLexeme {
  kind: SqlLexemeKind
  /** Half-open span in the scanned text. */
  start: number
  end: number
  /** The text as written (strings include quotes, idents include `""`). */
  raw: string
  /**
   * For `ident`: the name — unquoted identifiers keep their written spelling,
   * quoted ones have quotes stripped and doubled quotes unescaped. For
   * `string`: the inner content without prefix or quotes. Others: same as raw.
   */
  name: string
  /** For `ident`: true when double-quoted. */
  quoted: boolean
}

/** Mutable per-scan state; splitStatements updates it as statements finish. */
export interface SqlLexState {
  /** When false, backslash escapes are active inside every single-quoted
   * string; when true (the default), only inside E'…' and U&'…'. */
  standardConformingStrings: boolean
}

const IDENT_START = /[A-Za-z_\u0080-\uffff]/
const IDENT_PART = /[A-Za-z0-9_$\u0080-\uffff]/
const DIGIT = /[0-9]/

/**
 * Visit each lexeme of `sql` in order. Return `false` from the visitor to
 * stop scanning early. `state` lets a long-running consumer (the statement
 * splitter) carry `standard_conforming_strings` across statements; without it
 * the setting is assumed `on`, as PostgreSQL ships it.
 */
export function scanSqlLexemes(
  sql: string,
  visit: (lexeme: SqlLexeme) => boolean | void,
  state?: SqlLexState,
): void {
  const scsOff = state ? () => !state.standardConformingStrings : () => false
  const n = sql.length
  let i = 0

  while (i < n) {
    const ch = sql[i] as string

    if (/\s/.test(ch)) {
      let j = i + 1
      while (j < n && /\s/.test(sql[j] as string)) j++
      if (visit(punctLike('whitespace', i, j, sql)) === false) return
      i = j
      continue
    }
    if (ch === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i + 2)
      const j = end === -1 ? n : end
      if (visit(punctLike('lineComment', i, j, sql)) === false) return
      i = j
      continue
    }
    if (ch === '/' && sql[i + 1] === '*') {
      let depth = 1
      let j = i + 2
      while (j < n && depth > 0) {
        if (sql[j] === '/' && sql[j + 1] === '*') {
          depth++
          j += 2
        } else if (sql[j] === '*' && sql[j + 1] === '/') {
          depth--
          j += 2
        } else {
          j++
        }
      }
      if (visit(punctLike('blockComment', i, j, sql)) === false) return
      i = j
      continue
    }
    if (ch === "'") {
      // The prefix letters are read from the characters before the quote: a
      // standalone `E` enables backslash escapes, and so does `U&`. The char
      // guard keeps identifiers that merely end in `e`/`u` from counting.
      const p1 = sql[i - 1] ?? ''
      const p2 = sql[i - 2] ?? ''
      const p3 = sql[i - 3] ?? ''
      const eString = /e/i.test(p1) && !/^[A-Za-z0-9_$]/.test(p2)
      const uString = p1 === '&' && /u/i.test(p2) && !/^[A-Za-z0-9_$]/.test(p3)
      const escapeBackslashes = scsOff() || eString || uString
      let j = i + 1
      while (j < n) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") j += 2
          else {
            j++
            break
          }
        } else if (escapeBackslashes && sql[j] === '\\' && j + 1 < n) j += 2
        else j++
      }
      const raw = sql.slice(i, j)
      // Inner content between the opening quote and the closing one (or the
      // end, for an unterminated string); an E/U& prefix sits before it.
      const openQuote = raw.indexOf("'")
      const body = openQuote === -1
        ? ''
        : raw.slice(openQuote + 1, raw.endsWith("'") && raw.length > openQuote + 1 ? raw.length - 1 : raw.length)
      if (visit({ kind: 'string', start: i, end: j, raw, name: body, quoted: false }) === false) return
      i = j
      continue
    }
    if (ch === '"') {
      let j = i + 1
      let name = ''
      while (j < n) {
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') {
            name += '"'
            j += 2
          } else {
            j++
            break
          }
        } else {
          name += sql[j] as string
          j++
        }
      }
      if (visit({ kind: 'ident', start: i, end: j, raw: sql.slice(i, j), name, quoted: true }) === false) return
      i = j
      continue
    }
    if (ch === '$') {
      const previous = sql[i - 1]
      const tag =
        (!previous || !/[A-Za-z0-9_$]/.test(previous)) &&
        /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))
      if (tag) {
        const close = sql.indexOf(tag[0], i + tag[0].length)
        const j = close === -1 ? n : close + tag[0].length
        if (visit(punctLike('dollar', i, j, sql)) === false) return
        i = j
        continue
      }
    }
    if (IDENT_START.test(ch)) {
      let j = i + 1
      while (j < n && IDENT_PART.test(sql[j] as string)) j++
      if (visit({ kind: 'ident', start: i, end: j, raw: sql.slice(i, j), name: sql.slice(i, j), quoted: false }) === false) return
      i = j
      continue
    }
    if (DIGIT.test(ch)) {
      let j = i + 1
      while (j < n && DIGIT.test(sql[j] as string)) j++
      if (visit(punctLike('punct', i, j, sql)) === false) return
      i = j
      continue
    }
    if (visit(punctLike('punct', i, i + 1, sql)) === false) return
    i++
  }
}

/** A lexeme whose name is just its raw text (everything but ident/string). */
function punctLike(kind: SqlLexemeKind, start: number, end: number, sql: string): SqlLexeme {
  const raw = sql.slice(start, end)
  return { kind, start, end, raw, name: raw, quoted: false }
}
