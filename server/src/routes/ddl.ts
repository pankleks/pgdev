import type { FastifyInstance } from 'fastify'
import { getPool } from '../pools.js'
import { tableDdl, viewDdl, functionDdl } from '../catalog/ddl.js'

export async function ddlRoutes(app: FastifyInstance) {
  app.get('/api/connections/:id/ddl', async (req, reply) => {
    const { id } = req.params as { id: string }
    const { type, schema, name, oid } = req.query as {
      type: string
      schema: string
      name: string
      oid?: string
    }
    const pool = getPool(id)
    let ddl: string
    if (type === 'table') ddl = await tableDdl(pool, oid ?? '', schema, name)
    else if (type === 'view') ddl = await viewDdl(pool, oid ?? '', schema, name)
    else if (type === 'function') ddl = await functionDdl(pool, oid ?? '', schema, name)
    else return reply.code(400).send({ error: `Unknown object type: ${type}` })
    return { ddl }
  })
}
