import type { FastifyInstance, FastifyReply } from 'fastify'
import { getPool } from '../pools.js'
import { parseMaxRows } from '../queryshape.js'
import { runBatch, fetchNextPage, cancelRunning, closeTabSession, type BatchError } from '../queryexec.js'

// HTTP adapter for query execution. All client ownership, transaction
// handling, cursor sessions, and cleanup live in queryexec.ts; this module
// validates input, maps outcomes to status codes, and serializes errors.

interface QueryBody {
  sql?: string
  maxRows?: number
  tabKey?: string
}

interface MoreBody {
  tabKey?: string
  maxRows?: number
}

function mapError(error: BatchError): { code: number; body: unknown } {
  switch (error.kind) {
    case 'empty':
      return { code: 400, body: { error: 'Empty query' } }
    case 'running':
      return { code: 409, body: { error: 'A query is already running for this tab' } }
    case 'connect':
      return { code: 400, body: { error: error.message } }
    case 'no-more':
      return { code: 400, body: { error: 'No more rows — please re-run the query' } }
    case 'sql':
      return {
        code: 400,
        body: { error: error.message, position: error.position, code: error.code },
      }
  }
}

function errorReply(reply: FastifyReply, error: BatchError): unknown {
  const mapped = mapError(error)
  return reply.code(mapped.code).send(mapped.body)
}

export async function queryRoutes(app: FastifyInstance) {
  app.post('/api/connections/:id/query', async (req, reply) => {
    const { id } = req.params as { id: string }
    const { sql, maxRows, tabKey } = (req.body ?? {}) as QueryBody
    if (typeof sql !== 'string' || !sql.trim()) return reply.code(400).send({ error: 'Empty query' })
    const cap = parseMaxRows(maxRows)
    if (cap === null) return reply.code(400).send({ error: 'maxRows must be an integer from 1 to 10000' })
    const outcome = await runBatch(id, tabKey ?? '', sql, cap)
    if (outcome.kind === 'error') return errorReply(reply, outcome.error)
    return { results: outcome.results, durationMs: outcome.durationMs, transactionOpen: outcome.transactionOpen }
  })

  app.post('/api/connections/:id/query/more', async (req, reply) => {
    const { id } = req.params as { id: string }
    const { tabKey, maxRows } = (req.body ?? {}) as MoreBody
    const cap = parseMaxRows(maxRows)
    if (cap === null) return reply.code(400).send({ error: 'maxRows must be an integer from 1 to 10000' })
    const outcome = await fetchNextPage(id, tabKey ?? '', cap)
    if (outcome.kind === 'error') return errorReply(reply, outcome.error)
    const { rows, rowCount, truncated } = outcome
    return { rows, rowCount, truncated }
  })

  app.post('/api/connections/:id/cancel', async (req) => {
    const { id } = req.params as { id: string }
    const { tabKey } = (req.body ?? {}) as { tabKey?: string }
    return { ok: cancelRunning(id, tabKey ?? '') }
  })

  app.post('/api/connections/:id/query/close', async (req) => {
    const { id } = req.params as { id: string }
    const { tabKey } = (req.body ?? {}) as { tabKey?: string }
    getPool(id)
    await closeTabSession(id, tabKey ?? '')
    return { ok: true }
  })
}
