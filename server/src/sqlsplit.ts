import { scanSqlLexemes, type SqlLexState, type SqlLexeme } from './sqllex.js'

// Split SQL text into individual statements on top-level semicolons.
// Aware of single-quoted strings ('' escape), double-quoted identifiers,
// line/block comments, and dollar-quoted bodies ($$…$$, $tag$…$tag$),
// so function bodies and literals containing `;` stay intact. The lexing
// itself lives in sqllex.ts, shared with the query router and the agent gate.

const GUC = 'standard_conforming_strings'
/** Only the first few real tokens of a statement can form the SET that flips
 * the string mode; the buffer is capped accordingly. */
const SCS_WINDOW = 10

export function splitStatements(sql: string): string[] {
  const out: string[] = []
  const state: SqlLexState = { standardConformingStrings: true }
  let cur = ''
  /** Real (non-whitespace, non-comment) lexemes of the statement being
   * assembled, capped. Comments never matter for the SET pattern, so they
   * must not consume the window. */
  let tokens: SqlLexeme[] = []

  const finish = () => {
    const statement = cur.trim()
    if (statement) {
      out.push(statement)
      const setting = trackStandardConformingStrings(tokens)
      if (setting) state.standardConformingStrings = setting === 'on'
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
      if (
        lex.kind !== 'whitespace' && lex.kind !== 'lineComment' && lex.kind !== 'blockComment' &&
        tokens.length < SCS_WINDOW
      ) tokens.push(lex)
    },
    state,
  )
  finish()
  return out
}

/** Classify the leading `SET [LOCAL | SESSION] standard_conforming_strings
 * {TO | =} on|off` of a token run — bare-word occurrences only, so the same
 * spelling inside a literal or a comparison can never flip the string mode.
 * Returns the setting, or null when the statement does not set the GUC. */
function trackStandardConformingStrings(tokens: SqlLexeme[]): 'on' | 'off' | null {
  const word = (idx: number): string | null => {
    const t = tokens[idx]
    return t && t.kind === 'ident' && !t.quoted ? t.name.toLowerCase() : null
  }
  let k = 0
  if (word(k) !== 'set') return null
  k++
  const scope = word(k)
  if (scope === 'local' || scope === 'session') k++
  if (word(k) !== GUC) return null
  k++
  const sep = tokens[k]
  if (sep?.kind === 'ident' && !sep.quoted && sep.name.toLowerCase() === 'to') {
    k++
  } else if (sep?.kind === 'punct' && sep.raw === '=') {
    k++
  } else {
    return null
  }
  const value = tokens[k]
  if (!value) return null
  if (value.kind === 'ident' && !value.quoted) {
    const v = value.name.toLowerCase()
    return v === 'on' || v === 'off' ? v : null
  }
  if (value.kind === 'string') {
    const v = value.name.trim().toLowerCase()
    return v === 'on' || v === 'off' ? v : null
  }
  return null
}

/**
 * Classify one statement's effect on `standard_conforming_strings` for
 * consumers that track the setting statement by statement (the formatter's
 * dollar-segment scanner shares this detection with the splitter). Returns
 * the setting when the statement is a leading `SET [LOCAL | SESSION]
 * standard_conforming_strings {TO | =} on|off`, else null. Bare-word
 * occurrences only: the same spelling inside a literal or a comparison is
 * data, not a setting.
 */
export function applyStandardConformingSetting(statement: string): 'on' | 'off' | null {
  const tokens: SqlLexeme[] = []
  scanSqlLexemes(statement, (lex) => {
    if (
      lex.kind !== 'whitespace' && lex.kind !== 'lineComment' && lex.kind !== 'blockComment' &&
      tokens.length < SCS_WINDOW
    ) tokens.push(lex)
  })
  return trackStandardConformingStrings(tokens)
}
