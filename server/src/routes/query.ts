import type { FastifyInstance } from 'fastify'
import type { PoolClient } from 'pg'
import { getPool, setRunning, getRunning, deleteRunning } from '../pools.js'
import { cancelClientQuery } from '../pgcancel.js'
import { pgErrorMessage } from '../pgerror.js'
import { splitStatements } from '../sqlsplit.js'
import {
  sessionKey,
  getSession,
  setSession,
  beginSession,
  finishSession,
  teardownSession,
} from '../sessions.js'

interface QueryBody {
  sql?: string
  maxRows?: number
  tabKey?: string
}

interface MoreBody {
  tabKey?: string
  maxRows?: number
}

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
}

interface FetchedRows {
  fields: FieldInfo[]
  rows: unknown[][]
}

async function fetchRows(
  client: PoolClient,
  cursor: string,
  count: number,
): Promise<FetchedRows> {
  const res = await client.query({
    // Cursor names are server-generated (`pgdev_cur_N`), never user input.
    text: `FETCH FORWARD ${count} FROM "${cursor}"`,
    rowMode: 'array',
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

function withoutLeadingComments(sql: string): string {
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

function canUseCursor(stmt: string): boolean {
  return /^(SELECT|VALUES|SHOW|EXPLAIN|TABLE|SET|RESET|DISCARD|BEGIN|START|COMMIT|ROLLBACK|END|ABORT|SAVEPOINT|RELEASE|CLOSE|FETCH)\b/i.test(
    withoutLeadingComments(stmt),
  )
}

function requiresAutocommit(stmt: string): boolean {
  const text = withoutLeadingComments(stmt)
  if (/^(VACUUM|CLUSTER|CHECKPOINT|CREATE\s+DATABASE|DROP\s+DATABASE|ALTER\s+SYSTEM|CREATE\s+TABLESPACE|DROP\s+TABLESPACE|CREATE\s+SUBSCRIPTION|DROP\s+SUBSCRIPTION)\b/i.test(text)) {
    return true
  }
  if (/^(CREATE|DROP)\b[\s\S]*\bINDEX\b[\s\S]*\bCONCURRENTLY\b/i.test(text)) return true
  if (/^REINDEX\b[\s\S]*\bCONCURRENTLY\b/i.test(text)) return true
  return /^REFRESH\s+MATERIALIZED\s+VIEW\s+CONCURRENTLY\b/i.test(text)
}

function parseMaxRows(value: unknown): number | null {
  if (value === undefined) return 500
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 10000 ? value : null
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

export async function queryRoutes(app: FastifyInstance) {
  app.post('/api/connections/:id/query', async (req, reply) => {
    const { id } = req.params as { id: string }
    const { sql, maxRows, tabKey } = (req.body ?? {}) as QueryBody
    if (typeof sql !== 'string' || !sql.trim()) return reply.code(400).send({ error: 'Empty query' })
    const cap = parseMaxRows(maxRows)
    if (cap === null) return reply.code(400).send({ error: 'maxRows must be an integer from 1 to 10000' })
    const pool = getPool(id)
    const runKey = sessionKey(id, tabKey ?? '')
    if (getRunning(runKey)) {
      return reply.code(409).send({ error: 'A query is already running for this tab' })
    }
    // Drop any idle-open cursor from a previous truncated query on this tab.
    await teardownSession(runKey, 'rollback')
    const statements = splitStatements(sql)
    if (!statements.length) return reply.code(400).send({ error: 'Empty query' })
    const autocommit = statements.some(requiresAutocommit)

    const start = performance.now()
    let client: PoolClient
    try {
      client = await pool.connect()
    } catch (err) {
      return reply.code(400).send({ error: pgErrorMessage(err) })
    }
    if (getRunning(runKey)) {
      client.release()
      return reply.code(409).send({ error: 'A query is already running for this tab' })
    }

    // From here the client is owned either by the session map (kept open
    // for FETCH MORE) or released explicitly on every exit path.
    let sessionKept = false
    let inTxn = false
    setRunning(runKey, client)
    try {
      if (!autocommit) {
        await client.query('BEGIN')
        inTxn = true
        await client.query('SAVEPOINT pgdev_init')
        try {
          await client.query(`SET LOCAL idle_in_transaction_session_timeout = '5min'`)
        } catch {
          // Pre-9.6 servers: reaper + explicit teardown still apply.
          // The savepoint rollback below undoes the aborted state.
          try {
            await client.query('ROLLBACK TO SAVEPOINT pgdev_init')
          } catch {
            throw new Error('Unable to recover the query transaction')
          }
        }
      }

      const results: (
        | { kind: 'command'; command: string; rowCount: number }
        | { kind: 'data'; page: DataPage }
      )[] = []
      let seq = 0
      let openCursor: string | null = null
      // Only the final statement may retain a cursor. Earlier result sets are
      // materialized, so the UI never advertises a closed cursor as pageable.
      // A mutation-containing batch also finishes and commits in this request.
      const useCursors = !autocommit && statements.every(canUseCursor)

      // Direct execution for non-cursor statements. Throws on error so the
      // batch aborts with the statement's real message (never masked).
      // Also tracks user-typed transaction control (COMMIT/ROLLBACK/END).
      const execDirect = async (stmt: string): Promise<void> => {
        const control = withoutLeadingComments(stmt)
        const endsTxn = /^(COMMIT|ROLLBACK|END|ABORT)\b/i.test(control)
        const startsTxn = /^(BEGIN|START\s+TRANSACTION)\b/i.test(control)
        if (endsTxn) {
          // Ends our transaction server-side, taking any open cursor with it.
          openCursor = null
        }
        const res = await client.query({ text: stmt, rowMode: 'array' })
        if (endsTxn) inTxn = false
        if (startsTxn) inTxn = true
        if (!res.fields || res.fields.length === 0) {
          results.push({
            kind: 'command',
            command: res.command ?? 'OK',
            rowCount: res.rowCount ?? 0,
          })
        } else {
          const rows = res.rows.map((row: unknown[]) =>
            row.map((cell) => normalizeCell(cell)),
          )
          results.push({
            kind: 'data',
            page: {
              fields: (res.fields ?? []) as FieldInfo[],
              rows,
              hasMore: false,
              pendingRow: null,
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
      const mapped = results.map((r) => {
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
        }
      })

      const last = results[results.length - 1]
      if (last?.kind === 'data' && last.page.hasMore && openCursor) {
        setSession(runKey, id, client, openCursor, last.page.pendingRow)
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
      return { results: mapped, durationMs: Math.round(performance.now() - start) }
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
      const e = err as Error & { position?: string; code?: string }
      return reply
        .code(400)
        .send({
          error: pgErrorMessage(err, 'Query failed'),
          position: e.position ?? null,
          code: e.code ?? null,
        })
    } finally {
      deleteRunning(runKey, client)
    }
  })

  app.post('/api/connections/:id/query/more', async (req, reply) => {
    const { id } = req.params as { id: string }
    const { tabKey, maxRows } = (req.body ?? {}) as MoreBody
    const cap = parseMaxRows(maxRows)
    if (cap === null) return reply.code(400).send({ error: 'maxRows must be an integer from 1 to 10000' })
    getPool(id)
    const runKey = sessionKey(id, tabKey ?? '')
    if (getRunning(runKey)) {
      return reply.code(409).send({ error: 'A query is already running for this tab' })
    }
    const existing = getSession(runKey)
    if (!existing?.cursor) {
      return reply.code(400).send({ error: 'No more rows — please re-run the query' })
    }
    const sess = beginSession(runKey)
    if (!sess?.cursor) return reply.code(409).send({ error: 'A query is already running for this tab' })
    setRunning(runKey, sess.client)
    let finished = false
    try {
      if (!sess.pendingRow) {
        await teardownSession(runKey, 'rollback')
        return reply.code(400).send({ error: 'No more rows — please re-run the query' })
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
      return { rows, rowCount: rows.length, truncated: hasMore }
    } catch (err) {
      await teardownSession(runKey, 'rollback')
      const e = err as Error & { position?: string; code?: string }
      return reply
        .code(400)
        .send({
          error: pgErrorMessage(err, 'Query failed'),
          position: e.position ?? null,
          code: e.code ?? null,
        })
    } finally {
      if (!finished) await finishSession(runKey, sess, 'rollback')
      deleteRunning(runKey, sess.client)
    }
  })

  app.post('/api/connections/:id/cancel', async (req) => {
    const { id } = req.params as { id: string }
    const { tabKey } = (req.body ?? {}) as { tabKey?: string }
    const running = getRunning(sessionKey(id, tabKey ?? ''))
    if (!running) return { ok: false }
    cancelClientQuery(running)
    return { ok: true }
  })

  app.post('/api/connections/:id/query/close', async (req) => {
    const { id } = req.params as { id: string }
    const { tabKey } = (req.body ?? {}) as { tabKey?: string }
    getPool(id)
    const key = sessionKey(id, tabKey ?? '')
    // Let an in-flight request perform its own teardown. Releasing its client
    // here would race the FETCH/query currently using it.
    const running = getRunning(key)
    if (running) cancelClientQuery(running)
    else await teardownSession(key, 'rollback')
    return { ok: true }
  })
}
