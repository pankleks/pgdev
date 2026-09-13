import type { FastifyInstance } from 'fastify'
import { getCatalogPool } from '../pools.js'
import { fetchTableEditState, tableEditDdl } from '../catalog/tableedit.js'
import type { TableEditColumnInput, TableEditRequest } from '../schema-types.js'

// Table-editor endpoints. The catalog pool serves both, matching /schema and
// /ddl. The GET returns the dialog state; the POST diffs a submitted dialog
// against a fresh live read and returns the change-only ALTER script.

interface OidParams {
  id: string
  oid: string
}

/** Only plain numeric oids are accepted — a cast failure would surface as an
 * opaque 500, so the shape is checked here for a clean 400. */
function parseOid(raw: string): string | null {
  return /^\d{1,20}$/.test(raw) ? raw : null
}

function parseEditBody(body: unknown): TableEditRequest {
  if (!body || typeof body !== 'object') throw invalid('Invalid request body')
  const b = body as Partial<TableEditRequest>
  if (b.description !== null && typeof b.description !== 'string') {
    throw invalid('description must be a string or null')
  }
  if (b.description !== null && b.description.length > 5000) {
    throw invalid('description is too long')
  }
  if (typeof b.fingerprint !== 'string' || !b.fingerprint || b.fingerprint.length > 128) {
    throw invalid('The table state fingerprint is missing — reload the editor')
  }
  if (!Array.isArray(b.columns) || b.columns.length > 1000) {
    throw invalid('columns must be an array with at most 1000 entries')
  }
  const columns: TableEditColumnInput[] = []
  for (const entry of b.columns) {
    if (!entry || typeof entry !== 'object') throw invalid('Invalid column row')
    const c = entry as Partial<TableEditColumnInput>
    if (typeof c.id !== 'string' || !c.id || c.id.length > 255) throw invalid('Column identity is missing')
    if (typeof c.name !== 'string' || c.name.length > 255) throw invalid('Column name is missing')
    if (typeof c.type !== 'string' || c.type.length > 2000) throw invalid('Column type is missing')
    if (typeof c.nullable !== 'boolean') throw invalid('Column nullability is missing')
    if (c.defaultValue !== null && typeof c.defaultValue !== 'string') throw invalid('Invalid default value')
    if (c.defaultValue !== null && c.defaultValue.length > 5000) throw invalid('Default value is too long')
    if (c.description !== null && typeof c.description !== 'string') throw invalid('Invalid column description')
    if (c.description !== null && c.description.length > 5000) throw invalid('Column description is too long')
    columns.push({
      id: c.id,
      name: c.name,
      type: c.type,
      nullable: c.nullable,
      defaultValue: c.defaultValue ?? null,
      description: c.description ?? null,
    })
  }
  return { description: b.description ?? null, fingerprint: b.fingerprint, columns }
}

function invalid(message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode: 400 })
}

export async function tableEditRoutes(app: FastifyInstance) {
  app.get('/api/connections/:id/tableedit/:oid', async (req) => {
    const { id, oid } = req.params as OidParams
    const checked = parseOid(oid)
    if (!checked) throw invalid('Invalid object id')
    return fetchTableEditState(getCatalogPool(id), checked)
  })

  app.post('/api/connections/:id/tableedit/:oid', async (req) => {
    const { id, oid } = req.params as OidParams
    const checked = parseOid(oid)
    if (!checked) throw invalid('Invalid object id')
    const request = parseEditBody(req.body)
    const ddl = await tableEditDdl(getCatalogPool(id), checked, request)
    return { ddl }
  })
}
