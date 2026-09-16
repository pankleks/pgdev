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

/** True when the first token at or after `offset` is `(`. */
export function callSite(text: string, offset: number): boolean {
  for (const token of tokenize(text)) {
    if (token.start < offset) continue
    return token.kind === 'punct' && token.name === '('
  }
  return false
}
