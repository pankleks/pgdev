import type { FastifyInstance } from 'fastify'
import { getPool } from '../pools.js'
import { tableDdl, viewDdl, functionDdl, indexDdl, constraintDdl, triggerDdl } from '../catalog/ddl.js'

export async function ddlRoutes(app: FastifyInstance) {
  app.get('/api/connections/:id/ddl', async (req, reply) => {
    const { id } = req.params as { id: string }
    const { type, schema, name, oid, parent } = req.query as {
      type: string
      schema: string
      name: string
      oid?: string
      parent?: string
    }
    const pool = getPool(id)
    let ddl: string
    if (type === 'table') ddl = await tableDdl(pool, oid ?? '', schema, name)
    else if (type === 'view') ddl = await viewDdl(pool, oid ?? '', schema, name)
    else if (type === 'function') ddl = await functionDdl(pool, oid ?? '', schema, name)
    else if (type === 'index') ddl = await indexDdl(pool, schema, name)
    else if (type === 'constraint') ddl = await constraintDdl(pool, schema, parent ?? '', name)
    else if (type === 'trigger') ddl = await triggerDdl(pool, schema, parent ?? '', name)
    else return reply.code(400).send({ error: `Unknown object type: ${type}` })
    return { ddl }
  })
}
