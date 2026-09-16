import type { FastifyInstance } from 'fastify'
import type { PoolClient } from 'pg'
import { getPool } from '../pools.js'
import { fetchRowEditInfo } from '../catalog/rowedit.js'
import { planRowUpdate, type RowUpdateError } from '../rowupdate.js'
import { rawTextTypes } from '../pgtypes.js'
import { guardCheckedOutClient } from '../checkout.js'
import { pgErrorMessage } from '../pgerror.js'
import { sessionKey, getSession, beginSession, finishSession, parseTransactionId, assertTransaction, transactionState } from '../sessions.js'
import { normalizeCell } from '../queryexec.js'
import type { RowUpdateRequest } from '../schema-types.js'

// Row-editor endpoint: one row, one UPDATE. Everything is re-validated
// against a fresh catalog read here — the browser's editable metadata is
// advisory. When the tab has an open manual transaction, the UPDATE runs on
// that session's client so the user's COMMIT/ROLLBACK governs it; otherwise
// it is a single autocommit statement.

interface UpdateBody {
  tabKey?: unknown
  schema?: unknown
  table?: unknown
  key?: unknown
  set?: unknown
  transactionId?: unknown
}

type RunResult =
  | { kind: 'ok'; row: Record<string, unknown> }
  | { kind: 'not-found' }

function invalid(message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode: 400 })
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function parseBody(body: unknown): RowUpdateRequest {
  if (!isRecord(body)) throw invalid('Invalid request body')
  const { tabKey, schema, table, key, set, transactionId } = body
  if (typeof schema !== 'string' || !schema || schema.length > 255) {
    throw invalid('schema is required')
  }
  if (typeof table !== 'string' || !table || table.length > 255) {
    throw invalid('table is required')
  }
  if (tabKey !== undefined && typeof tabKey !== 'string') throw invalid('Invalid tab key')
  if (!isRecord(key) || !isRecord(set)) throw invalid('key and set must be objects')
  for (const column of [...Object.keys(key), ...Object.keys(set)]) {
    if (column.length > 255) throw invalid('Invalid column name')
  }
  return { tabKey: tabKey ?? '', schema, table, key, set, transactionId: parseTransactionId(transactionId) }
}

function planError(error: RowUpdateError): Error {
  switch (error.kind) {
    case 'key-mismatch':
      return invalid(`The row key must be exactly the primary key (${error.expected.join(', ')})`)
    case 'no-key':
      return invalid(`Missing primary key value for "${error.column}"`)
    case 'no-values':
      return invalid('No values to update')
    case 'unknown-column':
      return invalid(`Unknown column "${error.column}"`)
    case 'locked-column':
      return invalid(`Column "${error.column}" cannot be updated`)
    case 'bad-value':
      return invalid(`Invalid value for "${error.column}"`)
  }
}

function storedRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [column, value] of Object.entries(row)) out[column] = normalizeCell(value)
  return out
}

async function runUpdate(client: PoolClient, request: RowUpdateRequest): Promise<RunResult> {
  const info = await fetchRowEditInfo(client, request)
  if (!info) throw invalid('Table not found or not row-editable')
  if (!info.pk.length) throw invalid('The table has no primary key')
  const planned = planRowUpdate(request, info)
  if (planned.kind === 'error') throw planError(planned.error)

  let res
  try {
    res = await client.query({
      text: planned.text,
      values: planned.values,
      types: rawTextTypes,
    })
  } catch (err) {
    throw Object.assign(new Error(pgErrorMessage(err, 'Update failed')), { statusCode: 400 })
  }
  const row = res.rows[0]
  if (!row) return { kind: 'not-found' }
  return { kind: 'ok', row: storedRow(row) }
}

export async function rowUpdateRoutes(app: FastifyInstance) {
  app.post('/api/connections/:id/row-update', async (req, reply) => {
    const { id } = req.params as { id: string }
    const request = parseBody(req.body)
    const pool = getPool(id)
    const runKey = sessionKey(id, request.tabKey)
    assertTransaction(runKey, request.transactionId)
    const active = getSession(runKey)
    const sess = active?.kind === 'transaction' ? beginSession(runKey) : undefined
    if (active?.kind === 'transaction' && !sess) {
      return reply.code(409).send({ error: 'A query is already running for this tab', ...transactionState(runKey) })
    }

    const client = sess?.client ?? await pool.connect()
    if (!sess) guardCheckedOutClient(client)
    try {
      // Recheck after a potentially queued checkout, before any update runs.
      if (!sess) assertTransaction(runKey, request.transactionId)
      const result = await runUpdate(client, request)
      if (result.kind === 'not-found') {
        return reply.code(404).send({ error: 'Row not found — it may have been deleted; re-run the query.', ...transactionState(runKey) })
      }
      return { row: result.row, ...transactionState(runKey) }
    } catch (err) {
      throw Object.assign(err instanceof Error ? err : new Error(String(err)), transactionState(runKey))
    } finally {
      // Keep an open (possibly aborted) user transaction for COMMIT/ROLLBACK.
      if (sess) await finishSession(runKey, sess, 'keep')
      else client.release()
    }
  })
}
