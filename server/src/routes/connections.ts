import type { FastifyInstance } from 'fastify'
import { Pool } from 'pg'
import { randomUUID } from 'node:crypto'
import { setPool, removePool } from '../pools.js'
import { pgErrorMessage } from '../pgerror.js'
import { closeSessionsForConnection, closeSessionsForClient } from '../sessions.js'

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
    if (!b.connectionString) {
      // The parameter-form SSL flag is authoritative. Self-signed server
      // certificates are allowed when SSL is enabled.
      config.ssl = b.ssl ? { rejectUnauthorized: false } : false
    }
    config.max = 5
    config.statement_timeout = 30000
    // Tabs can hold a session client while paging large results; fail fast
    // instead of hanging forever when every pool slot is checked out.
    config.connectionTimeoutMillis = 10000
    config.application_name = 'pgDEV'

    const pool = new Pool(config)
    // Idle clients can die at any time (server restart, NAT/VPN timeout,
    // idle_session_timeout). Without this handler node-postgres rethrows as
    // an unhandled 'error' event and takes down the whole API process.
    pool.on('error', (err, client) => {
      console.error(`pg pool error: ${pgErrorMessage(err, 'Database connection error')}`)
      if (client) void closeSessionsForClient(client)
    })
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
    // Roll back open transactions and release session clients first —
    // pool.end() would otherwise wait on the checked-out clients.
    await closeSessionsForConnection(id)
    const removed = await removePool(id)
    if (!removed) return reply.code(404).send({ error: 'Unknown connection' })
    return { ok: true }
  })
}
