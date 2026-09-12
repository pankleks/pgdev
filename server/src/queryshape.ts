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
