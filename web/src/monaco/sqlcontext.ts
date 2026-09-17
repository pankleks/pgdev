// Pure SQL context helpers for hover and completion: which identifier is
// under a cursor offset, its dotted chain, and whether it is followed by `(`.
// The scanner skips strings, comments and dollar-quoted bodies (a cursor
// inside one has no identifier), while quoted identifiers become tokens so
// names like "My Col" resolve. The lexing itself lives in sqllex.ts, shared
// with the server's statement splitter and query router.

import { scanSqlLexemes } from '../../../server/src/sqllex'

export interface IdentifierAt {
  /** Identifier text without surrounding quotes. */
  name: string
  /** Identifier text as written (quoted identifiers keep their quotes). */
  raw: string
  /** Offsets into the scanned text; `end` is exclusive. */
  start: number
  end: number
  /** Dotted chain the identifier belongs to, outermost first, each part as
   * written (so callers can fold it with normIdent). */
  chain: string[]
  quoted: boolean
}

interface Token {
  kind: 'ident' | 'punct'
  start: number
  end: number
  name: string
  quoted: boolean
}

/** Tokens of `text`; whitespace, strings, comments and dollar bodies skip. */
function tokenize(text: string): Token[] {
  const tokens: Token[] = []
  scanSqlLexemes(text, (lex) => {
    if (lex.kind === 'ident') {
      tokens.push({ kind: 'ident', start: lex.start, end: lex.end, name: lex.name, quoted: lex.quoted })
    } else if (lex.kind === 'punct') {
      tokens.push({ kind: 'punct', start: lex.start, end: lex.end, name: lex.raw, quoted: false })
    }
  })
  return tokens
}

function rawOf(text: string, token: Token): string {
  return token.quoted ? text.slice(token.start, token.end) : token.name
}

/** The identifier containing `offset`, with its dotted chain, or null. */
export function identifierAt(text: string, offset: number): IdentifierAt | null {
  const tokens = tokenize(text)
  let index = -1
  for (let k = 0; k < tokens.length; k++) {
    const token = tokens[k] as Token
    if (token.kind === 'ident' && token.start <= offset && offset <= token.end) {
      index = k
      break
    }
  }
  if (index < 0) return null

  const token = tokens[index] as Token
  const chain = [rawOf(text, token)]

  let k = index - 1
  while (
    k - 1 >= 0 &&
    tokens[k]?.kind === 'punct' &&
    tokens[k]?.name === '.' &&
    tokens[k - 1]?.kind === 'ident'
  ) {
    chain.unshift(rawOf(text, tokens[k - 1] as Token))
    k -= 2
  }
  let m = index + 1
  while (
    m + 1 < tokens.length &&
    tokens[m]?.kind === 'punct' &&
    tokens[m]?.name === '.' &&
    tokens[m + 1]?.kind === 'ident'
  ) {
    chain.push(rawOf(text, tokens[m + 1] as Token))
    m += 2
  }

  return {
    name: token.name,
    raw: rawOf(text, token),
    start: token.start,
    end: token.end,
    chain,
    quoted: token.quoted,
  }
}

/** The dollar-quoted token whose interior contains `offset`, or null. */
function dollarTokenAt(text: string, offset: number): { raw: string; start: number } | null {
  let found: { raw: string; start: number } | null = null
  scanSqlLexemes(text, (lex) => {
    if (lex.start >= offset) return false
    if (lex.kind === 'dollar' && lex.start < offset && offset < lex.end) {
      found = { raw: lex.raw, start: lex.start }
      return false
    }
  })
  return found
}

/**
 * Span of the identifier the cursor is inside or immediately after, or null
 * when no identifier character precedes it. Quoted identifiers include their
 * quotes, so accepting a suggestion replaces `"My` rather than leaving a
 * dangling quote. The cursor strictly after a token's first character counts,
 * but sitting just before an identifier (e.g. `SELECT |FROM`) does not.
 */
export function identifierRangeAt(text: string, offset: number): { start: number; end: number } | null {
  // The lexer folds a whole dollar-quoted body into one token; rebase into it
  // so completion inside a routine body still replaces the typed symbol.
  const dollar = dollarTokenAt(text, offset)
  if (dollar) {
    const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(dollar.raw)?.[0] ?? '$$'
    const closed = dollar.raw.length >= tag.length * 2 && dollar.raw.endsWith(tag)
    const inner = dollar.raw.slice(tag.length, closed ? dollar.raw.length - tag.length : undefined)
    const innerOffset = offset - dollar.start - tag.length
    if (innerOffset >= 0 && innerOffset <= inner.length) {
      const range = identifierRangeAt(inner, innerOffset)
      const shift = dollar.start + tag.length
      return range ? { start: range.start + shift, end: range.end + shift } : null
    }
  }
  for (const token of tokenize(text)) {
    if (token.kind === 'ident' && token.start < offset && offset <= token.end) {
      return { start: token.start, end: token.end }
    }
  }
  return null
}

/** True when the first token at or after `offset` is `(`. */
export function callSite(text: string, offset: number): boolean {
  for (const token of tokenize(text)) {
    if (token.start < offset) continue
    return token.kind === 'punct' && token.name === '('
  }
  return false
}
