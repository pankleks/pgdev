import type { FastifyInstance } from 'fastify'
import { getPool } from '../pools.js'
import { fetchSchemaData } from '../catalog/metadata.js'

export async function metadataRoutes(app: FastifyInstance) {
  app.get('/api/connections/:id/schema', async (req) => {
    const { id } = req.params as { id: string }
    return fetchSchemaData(getPool(id))
  })
}
