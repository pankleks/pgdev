// Statement-routing heuristics for the query endpoint.
//
// These live apart from the route so they can be unit-tested directly: they
// decide whether a batch runs inside a transaction and whether a result is
// paged through a cursor, so a mistake here changes query semantics rather
// than just presentation.

/**
 * Strip leading whitespace and comments, so the routing regexes below match
 * the real first keyword. Handles nested block comments.
 */
export function withoutLeadingComments(sql: string): string {
  let i = 0
  while (i < sql.length) {
    while (/\s/.test(sql[i] ?? '')) i++
    if (sql[i] === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i + 2)
      i = end === -1 ? sql.length : end + 1
      continue
    }
    if (sql[i] === '/' && sql[i + 1] === '*') {
      let depth = 1
      i += 2
      while (i < sql.length && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth++
          i += 2
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--
          i += 2
        } else {
          i++
        }
      }
      continue
    }
    break
  }
  return sql.slice(i)
}

/** Transaction effect of a successfully executed statement. */
export function transactionControl(stmt: string): 'unchanged' | 'start' | 'end' | 'chain' {
  // Read only leading keyword tokens, skipping comments between them. Never
  // interpret keywords inside quoted savepoint names or string literals.
  const words: string[] = []
  let rest = stmt
  for (let i = 0; i < 5; i++) {
    rest = withoutLeadingComments(rest)
    const word = /^[A-Za-z_][A-Za-z_0-9$]*/.exec(rest)
    if (!word) break
    words.push(word[0].toUpperCase())
    rest = rest.slice(word[0].length)
  }
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
  return /^(SELECT|VALUES|WITH|SHOW|EXPLAIN|TABLE|SET|RESET|DISCARD|BEGIN|START|COMMIT|ROLLBACK|END|ABORT|SAVEPOINT|RELEASE|CLOSE|FETCH)\b/i.test(
    withoutLeadingComments(stmt),
  )
}

export function requiresAutocommit(stmt: string): boolean {
  const text = withoutLeadingComments(stmt)
  // The optional IF EXISTS / IF NOT EXISTS clause must not defeat the match:
  // `DROP DATABASE IF EXISTS d` is just as unable to run in a transaction, and
  // missing it would silently put the whole batch inside one.
  if (
    /^(VACUUM|CLUSTER|CHECKPOINT|CREATE\s+DATABASE|DROP\s+DATABASE|ALTER\s+SYSTEM|CREATE\s+TABLESPACE|DROP\s+TABLESPACE|CREATE\s+SUBSCRIPTION|DROP\s+SUBSCRIPTION)\b(?:\s+IF\s+(?:NOT\s+)?EXISTS)?/i.test(
      text,
    )
  ) {
    return true
  }
  if (/^(CREATE|DROP)\b[\s\S]*\bINDEX\b[\s\S]*\bCONCURRENTLY\b/i.test(text)) return true
  if (/^REINDEX\b[\s\S]*\bCONCURRENTLY\b/i.test(text)) return true
  return /^REFRESH\s+MATERIALIZED\s+VIEW\s+CONCURRENTLY\b/i.test(text)
}

/** Absent means the documented default of 500; anything else must be 1–10000. */
export function parseMaxRows(value: unknown): number | null {
  if (value === undefined) return 500
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 10000 ? value : null
}
