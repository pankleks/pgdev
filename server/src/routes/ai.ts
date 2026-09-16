import type { FastifyInstance, FastifyReply } from 'fastify'
import { timingSafeEqual } from 'node:crypto'
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
import { AI_LIMIT_RANGES, DEFAULT_AI_LIMITS, type AiLimits } from '../schema-types.js'

// AI surface for external agents (MCP clients, via bin/pgdev-mcp.mjs):
//   POST /api/ai/tool/:name      tool call, bearer-token only (the shim has no Origin)
//   GET  /api/ai/config          browser-facing: url, token, limits and a ready MCP config
//   PUT  /api/ai/limits          browser-facing: how much of a result set the agent sees
//   GET  /api/ai/bridge          SSE stream the browser subscribes to
//   POST /api/ai/bridge/result   the browser's answer to a bridge action
//
// Always registered: the token (stable per user, see ai/token.ts) is the guard.

/** A dedicated tab key for agent reads: the batch runs one-shot (no cursor
 * session is ever retained) and never joins a manual transaction. */
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
  // Live limits: the browser pushes the user's Settings choice and every tool
  // reads this object at call time. Server default until it does.
  const limits: AiLimits = { ...DEFAULT_AI_LIMITS }
  const tools = createAiTools({
    connectionIds,
    getSchema: (id: string) => fetchSchemaData(getCatalogPool(id)),
    getDdl: dispatchDdl,
    // The read-only transaction is what actually stops a write; the tool layer
    // checks the statement first so the common case gets a clear message.
    // One-shot: mirrored rows cannot page (the mirror tab's key differs), so
    // the batch is bounded and never leaves a cursor behind.
    runReadOnly: (id: string, sql: string, maxRows: number) =>
      runBatch(id, AI_TAB_KEY, wrapReadOnly(sql), maxRows, { pageable: false }),
    bridge,
    limits,
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
      url,
      token: options.token,
      command,
      config: JSON.stringify(config, null, 2),
      limits: { ...limits },
    }
  })

  // The browser owns this preference (Settings → AI agent) and pushes it on
  // load and on every change; the origin guard is what protects the endpoint.
  app.put('/api/ai/limits', async (req, reply) => {
    const body = (req.body ?? {}) as { maxRows?: unknown; maxBytes?: unknown }
    const rows = body.maxRows
    const bytes = body.maxBytes
    if (
      typeof rows !== 'number' ||
      !Number.isInteger(rows) ||
      rows < AI_LIMIT_RANGES.maxRows.min ||
      rows > AI_LIMIT_RANGES.maxRows.max
    ) {
      return reply.code(400).send({
        error: `maxRows must be an integer from ${AI_LIMIT_RANGES.maxRows.min} to ${AI_LIMIT_RANGES.maxRows.max}`,
      })
    }
    if (
      typeof bytes !== 'number' ||
      !Number.isInteger(bytes) ||
      bytes < AI_LIMIT_RANGES.maxBytes.min ||
      bytes > AI_LIMIT_RANGES.maxBytes.max
    ) {
      return reply.code(400).send({
        error: `maxBytes must be an integer from ${AI_LIMIT_RANGES.maxBytes.min} to ${AI_LIMIT_RANGES.maxBytes.max}`,
      })
    }
    limits.maxRows = rows
    limits.maxBytes = bytes
    return { ...limits }
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
