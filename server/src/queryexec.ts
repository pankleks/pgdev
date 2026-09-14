import type { PoolClient } from 'pg'
import { getPool, setRunning, getRunning, deleteRunning, runningKeysForConnection } from './pools.js'
import { rawJsonTypes } from './pgtypes.js'
import { cancelClientQuery } from './pgcancel.js'
import { guardCheckedOutClient } from './checkout.js'
import { splitStatements } from './sqlsplit.js'
import { boundedQuery } from './boundedquery.js'
import { pgErrorMessage } from './pgerror.js'
import {
  transactionControl,
  hasOpenTransaction,
  canUseCursor,
  requiresAutocommit,
} from './queryshape.js'
import {
  sessionKey,
  getSession,
  setSession,
  beginSession,
  finishSession,
  teardownSession,
} from './sessions.js'

// Batch execution engine, extracted from the Fastify route so HTTP concerns
// (status codes, reply shapes) stay in routes/query.ts and client ownership
// lives in exactly one place: from checkout to release, the client is owned
// either by this function (request-owned) or by a cursor session (paged).

export interface MappedCommand {
  kind: 'command'
  command: string
  rowCount: number
}

export interface MappedData {
  kind: 'data'
  columns: string[]
  columnTypes: string[]
  rows: unknown[][]
  rowCount: number
  truncated: boolean
  limited: boolean
  totalRowCount?: number
}

export type MappedResult = MappedCommand | MappedData

export type BatchError =
  | { kind: 'empty' }
  | { kind: 'open-transaction' }
  | { kind: 'running' }
  | { kind: 'connect'; message: string }
  | { kind: 'no-more' }
  | { kind: 'sql'; message: string; position: string | null; code: string | null }

export type BatchOutcome =
  | { kind: 'ok'; results: MappedResult[]; durationMs: number }
  | { kind: 'error'; error: BatchError }

export type MoreOutcome =
  | { kind: 'ok'; rows: unknown[][]; rowCount: number; truncated: boolean }
  | { kind: 'error'; error: BatchError }

function normalizeCell(v: unknown): unknown {
  if (Buffer.isBuffer(v)) return `<bytea ${v.length} bytes>`
  if (typeof v === 'object' && v !== null && !(v instanceof Date)) {
    try {
      return JSON.stringify(v)
    } catch {
      return String(v)
    }
  }
  return v
}

interface FieldInfo {
  name: string
  dataTypeID: number
}

interface DataPage {
  fields: FieldInfo[]
  rows: unknown[][]
  hasMore: boolean
  pendingRow: unknown[] | null
  limited?: boolean
  totalRowCount?: number
}

async function fetchRows(
  client: PoolClient,
  cursor: string,
  count: number,
): Promise<{ fields: FieldInfo[]; rows: unknown[][] }> {
  const res = await client.query({
    // Cursor names are server-generated (`pgdev_cur_N`), never user input.
    text: `FETCH FORWARD ${count} FROM "${cursor}"`,
    rowMode: 'array',
    types: rawJsonTypes,
  })
  return {
    fields: (res.fields ?? []) as FieldInfo[],
    rows: res.rows
      .map((row: unknown[]) => row.map((cell) => normalizeCell(cell))),
  }
}

async function fetchPage(
  client: PoolClient,
  cursor: string,
  cap: number,
): Promise<DataPage> {
  const fetched = await fetchRows(client, cursor, cap + 1)
  const hasMore = fetched.rows.length > cap
  return {
    fields: fetched.fields,
    rows: fetched.rows.slice(0, cap),
    hasMore,
    pendingRow: hasMore ? fetched.rows[cap] : null,
  }
}

async function closeCursor(
  client: PoolClient,
  cursor: string,
): Promise<void> {
  try {
    await client.query(`CLOSE "${cursor}"`)
  } catch {
    // Cursor may already be gone (error/cancel race) — teardown handles it.
  }
}

async function typeNamesFor(
  client: PoolClient,
  pages: DataPage[],
): Promise<Map<string, string>> {
  const typeIds = [
    ...new Set(pages.flatMap((p) => p.fields.map((f) => f.dataTypeID))),
  ]
  const typeNames = new Map<string, string>()
  if (!typeIds.length) return typeNames
  // Same client: no extra pool slot, so concurrent tabs can't starve.
  const tres = await client.query(
    `SELECT oid::text AS oid, format_type(oid, NULL) AS name FROM pg_type WHERE oid = ANY ($1::oid[])`,
    [typeIds],
  )
  for (const t of tres.rows) typeNames.set(t.oid, t.name)
  return typeNames
}

const sqlError = (err: unknown): BatchError => {
  const e = err as Error & { position?: string; code?: string }
  return {
    kind: 'sql',
    message: pgErrorMessage(err, 'Query failed'),
    position: e.position ?? null,
    code: e.code ?? null,
  }
}

/** Execute a SQL batch for one tab. See routes/query.ts for the HTTP mapping. */
export async function runBatch(
  connId: string,
  tabKey: string,
  sql: string,
  cap: number,
): Promise<BatchOutcome> {
  const statements = splitStatements(sql)
  if (!statements.length) return { kind: 'error', error: { kind: 'empty' } }
  // Validate the whole batch before executing anything (or closing an old
  // result cursor). Never silently commit a transaction the user left open.
  if (hasOpenTransaction(statements)) {
    return { kind: 'error', error: { kind: 'open-transaction' } }
  }
  const pool = getPool(connId)
  const runKey = sessionKey(connId, tabKey)
  if (getRunning(runKey)) return { kind: 'error', error: { kind: 'running' } }
  // Drop any idle-open cursor from a previous truncated query on this tab.
  await teardownSession(runKey, 'rollback')
  const autocommit = statements.some(requiresAutocommit)

  const start = performance.now()
  let client: PoolClient
  try {
    client = await pool.connect()
  } catch (err) {
    return { kind: 'error', error: { kind: 'connect', message: pgErrorMessage(err) } }
  }
  if (getRunning(runKey)) {
    client.release()
    return { kind: 'error', error: { kind: 'running' } }
  }
  // Cursor sessions hold this client for the life of the session; without a
  // listener a backend-side termination crashes the process (see checkout.ts).
  guardCheckedOutClient(client)

  // From here the client is owned either by the session map (kept open
  // for FETCH MORE) or released explicitly on every exit path.
  let sessionKept = false
  let inTxn = false
  setRunning(runKey, client)
  try {
    if (!autocommit) {
      await client.query('BEGIN')
      inTxn = true
      // Bounds how long a paged session may sit idle in its transaction
      // server-side; the reaper and explicit teardown back this up.
      await client.query(`SET LOCAL idle_in_transaction_session_timeout = '5min'`)
    }

    const results: (
      | { kind: 'command'; command: string; rowCount: number }
      | { kind: 'data'; page: DataPage }
    )[] = []
    let seq = 0
    let openCursor: string | null = null
    // Only the final statement may retain a cursor. Earlier result sets are
    // bounded and drained, so the UI never advertises a closed cursor as pageable.
    // A mutation-containing batch also finishes and commits in this request.
    const useCursors = !autocommit && statements.every(canUseCursor)

    // Direct execution for non-cursor statements. Throws on error so the
    // batch aborts with the statement's real message (never masked).
    // Also tracks user-typed transaction control (COMMIT/ROLLBACK/END).
    const execDirect = async (stmt: string): Promise<void> => {
      const control = transactionControl(stmt)
      const bounded = await boundedQuery(client, stmt, cap)
      const res = bounded.result
      if (control === 'end' || control === 'chain') {
        // Ends our transaction server-side, taking any open cursor with it.
        openCursor = null
      }
      if (control === 'end') inTxn = false
      if (control === 'start' || control === 'chain') inTxn = true
      if (!res.fields || res.fields.length === 0) {
        results.push({
          kind: 'command',
          command: res.command ?? 'OK',
          rowCount: res.rowCount ?? 0,
        })
      } else {
        const rows = bounded.rows.map((row: unknown[]) =>
          row.map((cell) => normalizeCell(cell)),
        )
        results.push({
          kind: 'data',
          page: {
            fields: (res.fields ?? []) as FieldInfo[],
            rows,
            hasMore: false,
            pendingRow: null,
            limited: bounded.totalRowCount > cap,
            totalRowCount: bounded.totalRowCount,
          },
        })
      }
    }

    for (const [index, stmt] of statements.entries()) {
      const cursor = `pgdev_cur_${++seq}`
      const cursorForThisStatement = useCursors && index === statements.length - 1
      if (!inTxn || !cursorForThisStatement) {
        await execDirect(stmt)
        continue
      }
      await client.query('SAVEPOINT pgdev_sp')
      try {
        await client.query(`DECLARE "${cursor}" NO SCROLL CURSOR FOR ${stmt}`)
      } catch (declareError) {
        // Not a cursor-compatible statement (DDL, writes, EXPLAIN, …):
        // roll back to the savepoint so the failed DECLARE doesn't poison
        // the transaction, then run it directly.
        try {
          await client.query('ROLLBACK TO SAVEPOINT pgdev_sp')
        } catch {
          throw declareError
        }
        await execDirect(stmt)
        continue
      }
      // A FETCH failure is a query failure, not evidence that the statement
      // should be executed again without a cursor.
      const page = await fetchPage(client, cursor, cap)
      if (page.hasMore) {
        // Only the last result set is pageable in the UI; earlier
        // truncated cursors are closed (their counts stay in Messages).
        if (openCursor) await closeCursor(client, openCursor)
        openCursor = cursor
      } else {
        await closeCursor(client, cursor)
      }
      results.push({ kind: 'data', page })
    }

    const typeNames = await typeNamesFor(
      client,
      results.flatMap((r) => (r.kind === 'data' ? [r.page] : [])),
    )
    const mapped: MappedResult[] = results.map((r) => {
      if (r.kind === 'command') {
        return { kind: 'command' as const, command: r.command, rowCount: r.rowCount }
      }
      return {
        kind: 'data' as const,
        columns: r.page.fields.map((f) => f.name),
        columnTypes: r.page.fields.map((f) => typeNames.get(String(f.dataTypeID)) ?? ''),
        rows: r.page.rows,
        rowCount: r.page.rows.length,
        truncated: r.page.hasMore,
        limited: r.page.limited ?? false,
        totalRowCount: r.page.totalRowCount,
      }
    })

    const last = results[results.length - 1]
    if (last?.kind === 'data' && last.page.hasMore && openCursor) {
      setSession(runKey, connId, client, openCursor, last.page.pendingRow)
      sessionKept = true
    } else {
      if (inTxn) {
        try {
          await client.query('COMMIT')
        } catch (err) {
          try {
            await client.query('ROLLBACK')
          } catch {
            // Transaction already gone.
          }
          throw err
        }
      }
      client.release()
    }
    return { kind: 'ok', results: mapped, durationMs: Math.round(performance.now() - start) }
  } catch (err) {
    await teardownSession(runKey, 'rollback')
    if (!sessionKept) {
      // Error before any session was kept: the client may still hold the
      // open (possibly aborted) transaction — roll back explicitly so a
      // dirty client never returns to the pool.
      if (inTxn) {
        try {
          await client.query('ROLLBACK')
        } catch {
          // Connection already gone; release() will drop it.
        }
      }
      try {
        client.release()
      } catch {
        // Already released.
      }
    }
    return { kind: 'error', error: sqlError(err) }
  } finally {
    deleteRunning(runKey, client)
  }
}

/** Fetch the next cursor page for a tab's retained session. */
export async function fetchNextPage(
  connId: string,
  tabKey: string,
  cap: number,
): Promise<MoreOutcome> {
  getPool(connId)
  const runKey = sessionKey(connId, tabKey)
  if (getRunning(runKey)) return { kind: 'error', error: { kind: 'running' } }
  const existing = getSession(runKey)
  if (!existing?.cursor) {
    return { kind: 'error', error: { kind: 'no-more' } }
  }
  const sess = beginSession(runKey)
  if (!sess?.cursor) return { kind: 'error', error: { kind: 'running' } }
  setRunning(runKey, sess.client)
  let finished = false
  try {
    if (!sess.pendingRow) {
      await teardownSession(runKey, 'rollback')
      return { kind: 'error', error: { kind: 'no-more' } }
    }
    const fetched = await fetchRows(sess.client, sess.cursor, cap)
    const combined = [sess.pendingRow, ...fetched.rows]
    const hasMore = combined.length > cap
    const rows = combined.slice(0, cap)
    if (!hasMore) {
      const done = sess.cursor
      sess.cursor = null
      sess.pendingRow = null
      await closeCursor(sess.client, done)
      await finishSession(runKey, sess, 'commit')
    } else {
      // Refresh the idle reaper while pages are still being consumed.
      sess.pendingRow = combined[cap] ?? null
      await finishSession(runKey, sess, 'keep')
    }
    finished = true
    return { kind: 'ok', rows, rowCount: rows.length, truncated: hasMore }
  } catch (err) {
    await teardownSession(runKey, 'rollback')
    return { kind: 'error', error: sqlError(err) }
  } finally {
    if (!finished) await finishSession(runKey, sess, 'rollback')
    deleteRunning(runKey, sess.client)
  }
}

/** Send a PostgreSQL cancel for the tab's running query, if any. */
export function cancelRunning(connId: string, tabKey: string): boolean {
  const running = getRunning(sessionKey(connId, tabKey))
  if (!running) return false
  cancelClientQuery(running)
  return true
}

/**
 * Cancel every query running on a connection, so disconnecting does not block
 * `pool.end()` on a request-owned (non-session) client until its statement
 * timeout fires. Sessions are handled separately by closeSessionsForConnection.
 */
export function cancelConnection(connId: string): void {
  for (const key of runningKeysForConnection(connId)) {
    const client = getRunning(key)
    if (client) cancelClientQuery(client)
  }
}

/**
 * Close an idle tab session, canceling an active operation instead —
 * releasing a busy client here would race the FETCH/query using it.
 */
export async function closeTabSession(connId: string, tabKey: string): Promise<void> {
  getPool(connId)
  const key = sessionKey(connId, tabKey)
  const running = getRunning(key)
  if (running) cancelClientQuery(running)
  else await teardownSession(key, 'rollback')
}
