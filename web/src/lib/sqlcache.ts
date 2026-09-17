// Shared lexical cache for the Monaco IntelliSense providers.
//
// Every provider used to lex the whole document on each keystroke: completion
// for identifiers, calls and the query scope; hover and signature help for
// their own views. One text-keyed memo removes the duplicate passes.
// JavaScript compares string keys by value, so an unchanged editor value hits
// the cache even though Monaco hands back a fresh string. A single slot per
// shape is enough: only the focused document is served between edits, and a
// new edit simply replaces it.
import { scanSqlLexemes, type SqlLexeme } from '../../../server/src/sqllex'

export interface SqlToken {
  kind: 'ident' | 'punct'
  start: number
  end: number
  /** The text as written (identifiers keep quotes, doubled quotes unescaped in `name`). */
  raw: string
  /** Unquoted name: quoted identifiers have their quotes stripped. */
  name: string
  quoted: boolean
}

let lexemeText = ''
let lexemes: SqlLexeme[] = []
let tokenText = ''
let tokens: SqlToken[] = []

/** Every lexeme of `text`, memoized by content. */
export function allLexemes(text: string): readonly SqlLexeme[] {
  if (text !== lexemeText) {
    const out: SqlLexeme[] = []
    scanSqlLexemes(text, (lex) => {
      out.push(lex)
    })
    lexemeText = text
    lexemes = out
  }
  return lexemes
}

/** Identifier and punctuation tokens of `text`, memoized by content. */
export function allTokens(text: string): readonly SqlToken[] {
  if (text !== tokenText) {
    const out: SqlToken[] = []
    for (const lex of allLexemes(text)) {
      if (lex.kind === 'ident') {
        out.push({
          kind: 'ident',
          start: lex.start,
          end: lex.end,
          raw: lex.raw,
          name: lex.name,
          quoted: lex.quoted,
        })
      } else if (lex.kind === 'punct') {
        out.push({ kind: 'punct', start: lex.start, end: lex.end, raw: lex.raw, name: lex.raw, quoted: false })
      }
    }
    tokenText = text
    tokens = out
  }
  return tokens
}
