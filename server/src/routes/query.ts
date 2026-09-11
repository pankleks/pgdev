import type { FastifyInstance } from 'fastify'
import { getPool, setRunning, getRunning, deleteRunning } from '../pools.js'
import { cancelClientQuery } from '../pgcancel.js'

interface QueryBody {
  sql?: string
  maxRows?: number
  tabKey?: string
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

export async function queryRoutes(app: FastifyInstance) {
  app.post('/api/connections/:id/query', async (req, reply) => {
    const { id } = req.params as { id: string }
    const { sql, maxRows, tabKey } = req.body as QueryBody
    if (!sql || !sql.trim()) return reply.code(400).send({ error: 'Empty query' })
    const cap = Math.max(1, Math.min(maxRows ?? 500, 10000))
    const pool = getPool(id)
    const start = performance.now()
    let client
    try {
      client = await pool.connect()
    } catch (err) {
      const e = err as Error
      return reply.code(400).send({ error: e.message })
    }
    const runKey = `${id}|${tabKey ?? ''}`
    const query = client.query({ text: sql, rowMode: 'array' })
    setRunning(runKey, client)
    try {
      const raw = await query
      const results = Array.isArray(raw) ? raw : [raw]
      const typeIds = [
        ...new Set(
          results.flatMap((r) => (r.fields ?? []).map((f: { dataTypeID: number }) => f.dataTypeID)),
        ),
      ]
      const typeNames = new Map<string, string>()
      if (typeIds.length) {
        const tres = await pool.query(
          `SELECT oid::text AS oid, format_type(oid, NULL) AS name FROM pg_type WHERE oid = ANY ($1::oid[])`,
          [typeIds],
        )
        for (const t of tres.rows) typeNames.set(t.oid, t.name)
      }
      const mapped = results.map((r) => {
        if (!r.fields || r.fields.length === 0) {
          return { kind: 'command' as const, command: r.command ?? 'OK', rowCount: r.rowCount ?? 0 }
        }
        return {
          kind: 'data' as const,
          columns: r.fields.map((f: { name: string }) => f.name),
          columnTypes: r.fields.map((f: { dataTypeID: number }) => typeNames.get(String(f.dataTypeID)) ?? ''),
          rows: r.rows
            .slice(0, cap)
            .map((row: unknown[]) => row.map((cell) => normalizeCell(cell))),
          rowCount: r.rows.length,
          truncated: r.rows.length > cap,
        }
      })
      return { results: mapped, durationMs: Math.round(performance.now() - start) }
    } catch (err) {
      const e = err as Error & { position?: string }
      return reply.code(400).send({ error: e.message, position: e.position ?? null })
    } finally {
      deleteRunning(runKey)
      client.release()
    }
  })

  app.post('/api/connections/:id/cancel', async (req) => {
    const { id } = req.params as { id: string }
    const { tabKey } = req.body as { tabKey?: string }
    const running = getRunning(`${id}|${tabKey ?? ''}`)
    if (!running) return { ok: false }
    cancelClientQuery(running)
    return { ok: true }
  })
}
