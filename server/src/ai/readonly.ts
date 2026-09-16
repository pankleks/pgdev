// Read-only gate for agent-issued SQL. The tool layer refuses anything that is
// not a plain read before it reaches the database; the statement then runs in
// a read-only transaction as well, so PostgreSQL is the real guarantee and
// this classifier only exists to give a clearer message (and to catch locking
// clauses that would otherwise fail with a database error).

import { splitStatements } from '../sqlsplit.js'
import { scanSqlLexemes } from '../sqllex.js'

const READ_COMMANDS = new Set(['SELECT', 'WITH', 'VALUES', 'TABLE', 'SHOW', 'EXPLAIN'])

export type ReadOnlyCheck = { ok: true } | { ok: false; reason: string }

/** Blank the contents of strings, comments, quoted identifiers and dollar
 * bodies so a keyword check cannot match inside them. Index-preserving. */
function maskLiterals(sql: string): string {
  let out = ''
  scanSqlLexemes(sql, (lex) => {
    const opaque =
      lex.kind === 'string' || lex.kind === 'dollar' || lex.kind === 'lineComment' ||
      lex.kind === 'blockComment' || (lex.kind === 'ident' && lex.quoted)
    out += opaque ? ' '.repeat(lex.end - lex.start) : lex.raw
  })
  return out
}

/** The first keyword of a statement, uppercased, skipping leading comments. */
function firstKeyword(stmt: string): string {
  let keyword = ''
  scanSqlLexemes(stmt, (lex) => {
    if (lex.kind === 'whitespace' || lex.kind === 'lineComment' || lex.kind === 'blockComment') return
    if (lex.kind === 'ident' && !lex.quoted) keyword = lex.name.toUpperCase()
    return false
  })
  return keyword
}

/** True when the statement carries a row-locking clause, which a read-only
 * transaction refuses anyway; the caller turns this into a clearer message. */
function hasLockingClause(stmt: string): boolean {
  return /\bFOR\s+(UPDATE|SHARE|NO\s+KEY\s+UPDATE|KEY\s+SHARE)\b/i.test(maskLiterals(stmt))
}

/**
 * Check a whole batch: every statement must be a bare read. An empty batch is
 * refused, and one write anywhere rejects the batch (the agent gets a clear
 * message instead of a half-applied batch).
 */
export function isReadOnlySql(sql: string): ReadOnlyCheck {
  const statements = splitStatements(sql)
  if (!statements.length) return { ok: false, reason: 'The query is empty.' }
  for (const stmt of statements) {
    const keyword = firstKeyword(stmt)
    if (!READ_COMMANDS.has(keyword)) {
      return {
        ok: false,
        reason:
          `"${keyword || '?'}" is not a read-only statement. The agent may run SELECT, WITH, ` +
          'VALUES, TABLE, SHOW or EXPLAIN; stage writes and DDL with set_active_query or ' +
          'open_query_tab and run them in pgDEV yourself.',
      }
    }
    if (hasLockingClause(stmt)) {
      return {
        ok: false,
        reason: 'Row-locking clauses (FOR UPDATE/SHARE) cannot run in the agent\'s read-only session.',
      }
    }
  }
  return { ok: true }
}

/**
 * Wrap a read-only batch so it runs with PostgreSQL's own read-only guarantee.
 * `SET TRANSACTION READ ONLY` must be the first statement of a transaction:
 * the batch engine opens one implicitly for these statements (none of the
 * allowed commands require autocommit), so the flag is applied to that
 * transaction — issuing our own `BEGIN` would only warn about a transaction
 * already in progress and silently drop the read-only mode.
 */
export function wrapReadOnly(sql: string): string {
  const body = sql.trim().replace(/;+\s*$/, '').trim()
  return `SET TRANSACTION READ ONLY;\n${body};`
}
