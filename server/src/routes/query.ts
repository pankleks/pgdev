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
}

async function fetchPage(
  client: PoolClient,
  cursor: string,
  cap: number,
): Promise<DataPage> {
  const res = await client.query({
    // Cursor names are server-generated (`pgdev_cur_N`), never user input.
    text: `FETCH FORWARD ${cap + 1} FROM "${cursor}"`,
    rowMode: 'array',
  })
  const hasMore = res.rows.length > cap
  return {
    fields: (res.fields ?? []) as FieldInfo[],
    rows: res.rows
      .slice(0, cap)
      .map((row: unknown[]) => row.map((cell) => normalizeCell(cell))),
    hasMore,
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

export async function queryRoutes(app: FastifyInstance) {
  app.post('/api/connections/:id/query', async (req, reply) => {
    const { id } = req.params as { id: string }
    const { sql, maxRows, tabKey } = req.body as QueryBody
    if (!sql || !sql.trim()) return reply.code(400).send({ error: 'Empty query' })
    const cap = Math.max(1, Math.min(maxRows ?? 500, 10000))
    const pool = getPool(id)
    const runKey = sessionKey(id, tabKey ?? '')
    if (getRunning(runKey)) {
      return reply.code(409).send({ error: 'A query is already running for this tab' })
    }
    // Drop any idle-open cursor from a previous truncated query on this tab.
    await teardownSession(runKey, 'rollback')
    const statements = splitStatements(sql)
    if (!statements.length) return reply.code(400).send({ error: 'Empty query' })

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
    setRunning(runKey, client)
    try {
      await client.query('BEGIN')
      let inTxn = true
      try {
        await client.query('SAVEPOINT pgdev_init')
        try {
          await client.query(`SET LOCAL idle_in_transaction_session_timeout = '5min'`)
        } catch {
          // Pre-9.6 servers: reaper + explicit teardown still apply.
          // The savepoint rollback below undoes the aborted state.
          try {
            await client.query('ROLLBACK TO SAVEPOINT pgdev_init')
          } catch {
            inTxn = false
          }
        }
      } catch {
        inTxn = false
      }

      const results: (
        | { kind: 'command'; command: string; rowCount: number }
        | { kind: 'data'; page: DataPage }
      )[] = []
      let seq = 0
      let openCursor: string | null = null

      // Direct execution for non-cursor statements. Throws on error so the
      // batch aborts with the statement's real message (never masked).
      // Also tracks user-typed transaction control (COMMIT/ROLLBACK/END).
      const execDirect = async (stmt: string): Promise<void> => {
        if (/^\s*(COMMIT|ROLLBACK|END|ABORT)\b/i.test(stmt)) {
          // Ends our transaction server-side, taking any open cursor with it.
          openCursor = null
        }
        const res = await client.query({ text: stmt, rowMode: 'array' })
        if (/^\s*(COMMIT|ROLLBACK|END|ABORT)\b/i.test(stmt)) inTxn = false
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
              rows: rows.slice(0, cap),
              hasMore: rows.length > cap,
            },
          })
        }
      }

      for (const stmt of statements) {
        const cursor = `pgdev_cur_${++seq}`
        if (!inTxn) {
          await execDirect(stmt)
          continue
        }
        try {
          await client.query('SAVEPOINT pgdev_sp')
        } catch {
          inTxn = false
          await execDirect(stmt)
          continue
        }
        let page: DataPage | null = null
        try {
          await client.query(`DECLARE "${cursor}" NO SCROLL CURSOR FOR ${stmt}`)
          page = await fetchPage(client, cursor, cap)
        } catch {
          // Not a cursor-compatible statement (DDL, writes, EXPLAIN, …):
          // roll back to the savepoint so the failed DECLARE doesn't poison
          // the transaction, then run it directly. Such statements return
          // command tags or a handful of rows, so materializing is safe.
          try {
            await client.query('ROLLBACK TO SAVEPOINT pgdev_sp')
          } catch {
            inTxn = false
          }
          await execDirect(stmt)
          continue
        }
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
        setSession(runKey, id, client, openCursor)
        sessionKept = true
      } else {
        try {
          await client.query('COMMIT')
        } catch {
          try {
            await client.query('ROLLBACK')
          } catch {
            // Transaction already gone.
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
        try {
          await client.query('ROLLBACK')
        } catch {
          // Connection already gone; release() will drop it.
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
    const { tabKey, maxRows } = req.body as MoreBody
    const cap = Math.max(1, Math.min(maxRows ?? 500, 10000))
    getPool(id)
    const runKey = sessionKey(id, tabKey ?? '')
    if (getRunning(runKey)) {
      return reply.code(409).send({ error: 'A query is already running for this tab' })
    }
    const sess = getSession(runKey)
    if (!sess?.cursor) {
      return reply.code(400).send({ error: 'No more rows — please re-run the query' })
    }
    setRunning(runKey, sess.client)
    try {
      const page = await fetchPage(sess.client, sess.cursor, cap)
      if (!page.hasMore) {
        const done = sess.cursor
        sess.cursor = null
        await closeCursor(sess.client, done)
        await teardownSession(runKey, 'commit')
      } else {
        // Refresh the idle reaper while pages are still being consumed.
        setSession(runKey, id, sess.client, sess.cursor)
      }
      return { rows: page.rows, rowCount: page.rows.length, truncated: page.hasMore }
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
      deleteRunning(runKey, sess.client)
    }
  })

  app.post('/api/connections/:id/cancel', async (req) => {
    const { id } = req.params as { id: string }
    const { tabKey } = req.body as { tabKey?: string }
    const running = getRunning(sessionKey(id, tabKey ?? ''))
    if (!running) return { ok: false }
    cancelClientQuery(running)
    return { ok: true }
  })
}
