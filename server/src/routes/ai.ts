import type { FastifyInstance, FastifyReply } from 'fastify'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { connectionIds, getCatalogPool } from '../pools.js'
import { fetchSchemaData } from '../catalog/metadata.js'
import {
  tableDdl,
  viewDdl,
  functionDdl,
  indexDdl,
  constraintDdl,
  triggerDdl,
  typeDdl,
} from '../catalog/ddl.js'
import { runBatch } from '../queryexec.js'
import { createBridge } from '../ai/bridge.js'
import { createAiTools, type DdlTarget } from '../ai/tools.js'
import { wrapReadOnly } from '../ai/readonly.js'

// AI surface for external agents (MCP clients, via bin/pgdev-mcp.mjs):
//   POST /api/ai/tool/:name      tool call, bearer-token only (the shim has no Origin)
//   GET  /api/ai/config          browser-facing: url, token and a ready MCP config
//   GET  /api/ai/bridge          SSE stream the browser subscribes to
//   POST /api/ai/bridge/result   the browser's answer to a bridge action
//
// Registered only when AI is enabled (see app.ts), so the endpoints and token
// do not exist otherwise.

/** One key per server run; only the terminal/agent ever sees it. */
export function createAiToken(): string {
  return randomBytes(32).toString('hex')
}

/** A dedicated tab key for agent reads: no cursor session, no manual transaction. */
const AI_TAB_KEY = 'ai'

export interface AiRouteOptions {
  token: string
}

function bearerMatches(header: unknown, token: string): boolean {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false
  const given = Buffer.from(header.slice(7))
  const expected = Buffer.from(token)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

async function dispatchDdl(connectionId: string, target: DdlTarget): Promise<string> {
  const pool = getCatalogPool(connectionId)
  switch (target.type) {
    case 'table':
      return tableDdl(pool, target.oid ?? '', target.schema, target.name)
    case 'view':
      return viewDdl(pool, target.oid ?? '', target.schema, target.name)
    case 'function':
      return functionDdl(pool, target.oid ?? '', target.schema, target.name)
    case 'index':
      return indexDdl(pool, target.schema, target.name)
    case 'constraint':
      return constraintDdl(pool, target.schema, target.parent ?? '', target.name)
    case 'trigger':
      return triggerDdl(pool, target.schema, target.parent ?? '', target.name)
    case 'type':
      return typeDdl(pool, target.oid ?? '', target.schema, target.name)
    default:
      throw new Error(`Unknown object type: ${target.type}`)
  }
}

export async function aiRoutes(app: FastifyInstance, options: AiRouteOptions) {
  const bridge = createBridge()
  const tools = createAiTools({
    connectionIds,
    getSchema: (id: string) => fetchSchemaData(getCatalogPool(id)),
    getDdl: dispatchDdl,
    // The read-only transaction is what actually stops a write; the tool layer
    // checks the statement first so the common case gets a clear message.
    runReadOnly: (id: string, sql: string, maxRows: number) =>
      runBatch(id, AI_TAB_KEY, wrapReadOnly(sql), maxRows),
    bridge,
  })

  app.post('/api/ai/tool/:name', async (req, reply) => {
    if (!bearerMatches(req.headers.authorization, options.token)) {
      return reply.code(401).send({ error: 'Invalid or missing token' })
    }
    const { name } = req.params as { name: string }
    const tool = tools[name]
    if (!tool) return reply.code(404).send({ error: `Unknown tool "${name}"` })
    return tool((req.body ?? {}) as Record<string, unknown>)
  })

  app.get('/api/ai/config', async () => {
    const port = Number(process.env.PORT) || 3010
    const url = `http://localhost:${port}`
    const command = fileURLToPath(new URL('../../../bin/pgdev-mcp.mjs', import.meta.url))
    const config = {
      $schema: 'https://opencode.ai/config.json',
      mcp: {
        pgdev: {
          type: 'local',
          command: ['node', command],
          environment: { PGDEV_URL: url, PGDEV_TOKEN: options.token },
          enabled: true,
        },
      },
    }
    return {
      enabled: true,
      url,
      token: options.token,
      command,
      config: JSON.stringify(config, null, 2),
    }
  })

  app.get('/api/ai/bridge', (req, reply: FastifyReply) => {
    // Take the socket over: this response never ends while the page is open.
    reply.hijack()
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    reply.raw.write(': connected\n\n')
    const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), 15000)
    if (typeof heartbeat.unref === 'function') heartbeat.unref()
    const unsubscribe = bridge.subscribe((event) => {
      reply.raw.write(`data: ${event}\n\n`)
    })
    req.raw.on('close', () => {
      clearInterval(heartbeat)
      unsubscribe()
    })
  })

  app.post('/api/ai/bridge/result', async (req) => {
    const { id, result, error } = (req.body ?? {}) as {
      id?: unknown
      result?: unknown
      error?: string | null
    }
    if (typeof id !== 'string' || !id) return { ok: false }
    return { ok: bridge.resolve(id, result, typeof error === 'string' ? error : null) }
  })
}
