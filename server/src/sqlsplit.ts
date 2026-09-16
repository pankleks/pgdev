import { scanSqlLexemes, type SqlLexState, type SqlLexeme } from './sqllex.js'

// Split SQL text into individual statements on top-level semicolons.
// Aware of single-quoted strings ('' escape), double-quoted identifiers,
// line/block comments, and dollar-quoted bodies ($$…$$, $tag$…$tag$),
// so function bodies and literals containing `;` stay intact. The lexing
// itself lives in sqllex.ts, shared with the query router and the agent gate.

const GUC = 'standard_conforming_strings'
/** Only the first few tokens of a statement can form the SET that flips the
 * string mode; the buffer is capped accordingly. */
const SCS_WINDOW = 10

export function splitStatements(sql: string): string[] {
  const out: string[] = []
  const state: SqlLexState = { standardConformingStrings: true }
  let cur = ''
  /** Non-whitespace lexemes of the statement being assembled (capped). */
  let tokens: SqlLexeme[] = []

  const finish = () => {
    const statement = cur.trim()
    if (statement) {
      out.push(statement)
      trackStandardConformingStrings(tokens, state)
    }
    cur = ''
    tokens = []
  }

  scanSqlLexemes(sql,
    (lex) => {
      if (lex.kind === 'punct' && lex.raw === ';') {
        finish()
        return
      }
      cur += lex.raw
      // The SET that flips the mode must start its own statement, so only a
      // few leading tokens can ever matter (a spelling of the GUC name inside
      // a string literal, comment or deep expression is data, not a setting).
      if (lex.kind !== 'whitespace' && tokens.length < SCS_WINDOW) tokens.push(lex)
    },
    state,
  )
  finish()
  return out
}

/** Apply `SET [LOCAL | SESSION] standard_conforming_strings {TO | =} on|off` —
 * bare-word occurrences only, so the same spelling inside a literal or a
 * comparison can never flip how later statements are split. */
function trackStandardConformingStrings(tokens: SqlLexeme[], state: SqlLexState): void {
  const words = tokens.filter((t) => t.kind !== 'lineComment' && t.kind !== 'blockComment')
  const word = (idx: number): string | null => {
    const t = words[idx]
    return t && t.kind === 'ident' && !t.quoted ? t.name.toLowerCase() : null
  }
  let k = 0
  if (word(k) !== 'set') return
  k++
  const scope = word(k)
  if (scope === 'local' || scope === 'session') k++
  if (word(k) !== GUC) return
  k++
  const sep = words[k]
  if (sep?.kind === 'ident' && !sep.quoted && sep.name.toLowerCase() === 'to') {
    k++
  } else if (sep?.kind === 'punct' && sep.raw === '=') {
    k++
  } else {
    return
  }
  const value = words[k]
  if (!value) return
  if (value.kind === 'ident' && !value.quoted) {
    const v = value.name.toLowerCase()
    if (v === 'on' || v === 'off') state.standardConformingStrings = v === 'on'
    return
  }
  if (value.kind === 'string') {
    const v = value.name.trim().toLowerCase()
    if (v === 'on' || v === 'off') state.standardConformingStrings = v === 'on'
  }
}
