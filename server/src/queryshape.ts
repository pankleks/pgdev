// Statement-routing heuristics for the query endpoint.
//
// These live apart from the route so they can be unit-tested directly: they
// decide whether a batch runs inside a transaction and whether a result is
// paged through a cursor, so a mistake here changes query semantics rather
// than just presentation. The lexing itself lives in sqllex.ts, shared with
// the statement splitter and the agent gate.

import { scanSqlLexemes } from './sqllex.js'

/** Keywords whose statements DECLARE can take (checked on the first word). */
const CURSOR_KEYWORDS = new Set([
  'select', 'values', 'with', 'show', 'explain', 'table',
  'set', 'reset', 'discard', 'begin', 'start', 'commit', 'rollback', 'end',
  'abort', 'savepoint', 'release', 'close', 'fetch',
])

/**
 * Strip leading whitespace and comments, so keyword checks match the real
 * first token. Handles nested block comments.
 */
export function withoutLeadingComments(sql: string): string {
  let start = sql.length
  scanSqlLexemes(sql, (lex) => {
    if (lex.kind === 'whitespace' || lex.kind === 'lineComment' || lex.kind === 'blockComment') return
    start = lex.start
    return false
  })
  return sql.slice(start)
}

/** The statement's leading keyword tokens, uppercased, skipping comments
 * between them. Stops at the first token that is not a bare word. */
function leadingKeywords(stmt: string, limit: number): string[] {
  const words: string[] = []
  scanSqlLexemes(stmt, (lex) => {
    if (lex.kind === 'whitespace' || lex.kind === 'lineComment' || lex.kind === 'blockComment') return
    if (lex.kind === 'ident' && !lex.quoted && words.length < limit) {
      words.push(lex.name.toUpperCase())
      return
    }
    return false
  })
  return words
}

/** Transaction effect of a successfully executed statement. */
export function transactionControl(stmt: string): 'unchanged' | 'start' | 'end' | 'chain' {
  // Read only leading keyword tokens; never interpret keywords inside quoted
  // savepoint names or string literals (the scanner makes those opaque).
  const words = leadingKeywords(stmt, 5)
  const first = words.shift()
  if (first === 'BEGIN' || (first === 'START' && words[0] === 'TRANSACTION')) return 'start'
  if (!first || !['COMMIT', 'ROLLBACK', 'END', 'ABORT'].includes(first)) return 'unchanged'
  if (words[0] === 'WORK' || words[0] === 'TRANSACTION') words.shift()
  if (first === 'ROLLBACK' && words[0] === 'TO') return 'unchanged'
  // These commit/roll back a prepared transaction, not the current session's.
  if ((first === 'COMMIT' || first === 'ROLLBACK') && words[0] === 'PREPARED') return 'unchanged'
  return words[0] === 'AND' && words[1] === 'CHAIN' ? 'chain' : 'end'
}

/** Explicit transactions must be completed within the submitted batch. */
export function hasOpenTransaction(statements: string[]): boolean {
  let open = false
  for (const stmt of statements) {
    const control = transactionControl(stmt)
    if (control === 'start' || control === 'chain') open = true
    if (control === 'end') open = false
  }
  return open
}

export function canUseCursor(stmt: string): boolean {
  // WITH is included so CTE queries (`WITH … SELECT …`) are paged instead of
  // being materialized in full. DECLARE only accepts SELECT/VALUES, so a
  // data-modifying CTE (`WITH … INSERT/UPDATE/DELETE …`) still fails at
  // DECLARE and falls back to direct execution via the savepoint.
  const first = leadingKeywords(stmt, 1)[0]?.toLowerCase() ?? ''
  return CURSOR_KEYWORDS.has(first)
}

/** Non-keyword tokens cannot form the commands below, so the leading word
 * run (comments skipped, strings opaque) is all the check needs. */
export function requiresAutocommit(stmt: string): boolean {
  const words = leadingKeywords(stmt, 8).map((w) => w.toLowerCase())
  const first = words[0] ?? ''
  if (first === 'vacuum' || first === 'cluster' || first === 'checkpoint') return true
  if (first === 'reindex') return words.includes('concurrently')
  if (first === 'refresh') {
    return words[1] === 'materialized' && words[2] === 'view' && words.includes('concurrently')
  }
  if (first === 'alter') return words[1] === 'system'
  if (first === 'create' || first === 'drop') {
    // The optional IF [NOT] EXISTS / UNIQUE lead-in must not defeat the match:
    // `DROP DATABASE IF EXISTS d` is just as unable to run in a transaction,
    // and a comment between the words must not hide it either.
    for (let k = 1; k < words.length; k++) {
      if (words[k] === 'database' || words[k] === 'tablespace' || words[k] === 'subscription') return true
      if (words[k] === 'index') return words.slice(k + 1).includes('concurrently')
      if (!['if', 'not', 'exists', 'unique', 'concurrently'].includes(words[k])) break
    }
  }
  return false
}

/** Absent means the documented default of 500; anything else must be 1–10000. */
export function parseMaxRows(value: unknown): number | null {
  if (value === undefined) return 500
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 10000 ? value : null
}
