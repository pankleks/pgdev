import type { FastifyInstance } from 'fastify'
import { getCatalogPool } from '../pools.js'
import { objectDdl } from '../catalog/ddl.js'

export async function ddlRoutes(app: FastifyInstance) {
  app.get('/api/connections/:id/ddl', async (req) => {
    const { id } = req.params as { id: string }
    const { type, schema, name, oid, parent } = req.query as {
      type: string
      schema: string
      name: string
      oid?: string
      parent?: string
    }
    const ddl = await objectDdl(getCatalogPool(id), { type, schema, name, oid, parent })
    return { ddl }
  })
}
