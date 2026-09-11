import type { FastifyInstance } from 'fastify'
import { Pool } from 'pg'
import { randomUUID } from 'node:crypto'
import { setPool, removePool } from '../pools.js'
import { pgErrorMessage } from '../pgerror.js'

interface ConnectBody {
  connectionString?: string
  host?: string
  port?: number
  database?: string
  user?: string
  password?: string
  ssl?: boolean
}

export async function connectionRoutes(app: FastifyInstance) {
  app.post('/api/connections', async (req, reply) => {
    const b = req.body as ConnectBody
    const config: Record<string, unknown> = b.connectionString
      ? { connectionString: b.connectionString }
      : {
          host: b.host || 'localhost',
          port: b.port || 5432,
          database: b.database,
          user: b.user,
          password: b.password,
        }
    if (b.ssl) config.ssl = { rejectUnauthorized: false }
    config.max = 5
    config.statement_timeout = 30000
    config.application_name = 'pgdev'

    const pool = new Pool(config)
    try {
      const client = await pool.connect()
      client.release()
    } catch (err) {
      await pool.end().catch(() => {})
      return reply.code(400).send({ error: pgErrorMessage(err) })
    }

    const id = randomUUID()
    setPool(id, pool)
    return { id }
  })

  app.delete('/api/connections/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const removed = await removePool(id)
    if (!removed) return reply.code(404).send({ error: 'Unknown connection' })
    return { ok: true }
  })
}
