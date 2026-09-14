import Fastify, { type FastifyInstance } from 'fastify'
import fastifyStatic from '@fastify/static'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { connectionRoutes } from './routes/connections.js'
import { metadataRoutes } from './routes/metadata.js'
import { ddlRoutes } from './routes/ddl.js'
import { queryRoutes } from './routes/query.js'
import { tableEditRoutes } from './routes/tableedit.js'
import { rowUpdateRoutes } from './routes/rowupdate.js'
import { appVersion } from './version.js'

// Application construction lives here rather than in index.ts so tests can
// start the real app — including the origin guard — without binding a port.

export interface AppOptions {
  /**
   * Serve the production web build when it exists. Disable it in tests so a
   * stale dist cannot influence the response under test.
   */
  serveStatic?: boolean
}

export function isLoopback(host: string): boolean {
  // URL.hostname keeps the brackets on an IPv6 literal ("[::1]").
  const h = host.toLowerCase().replace(/^\[|\]$/g, '')
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.localhost')
}

export function effectivePort(url: URL): number {
  return Number(url.port) || (url.protocol === 'https:' ? 443 : 80)
}

function requestUrl(req: { protocol: string; headers: { host?: string } }): URL | null {
  try {
    return new URL(`${req.protocol}://${String(req.headers.host ?? '')}`)
  } catch {
    return null
  }
}

/**
 * The API has no auth and will dial any database, so a cross-origin browser
 * request must not be able to drive it. Browser fetches carry an Origin that
 * must match the full request origin; same-origin GETs may omit Origin, in
 * which case the browser-controlled Sec-Fetch-Site header is accepted. The
 * Vite dev proxy is the one intentional cross-port exception.
 */
export function allowedOrigin(reqUrl: URL, originUrl: URL): boolean {
  const hostA = originUrl.hostname.toLowerCase()
  const hostB = reqUrl.hostname.toLowerCase()
  // localhost, 127.0.0.1 and ::1 are the same machine, and browsers and the
  // launcher pick between them inconsistently: opening http://localhost:3010
  // while the request host is 127.0.0.1 must not be rejected as cross-origin.
  // This widens nothing — both sides are still loopback.
  const sameHost = hostA === hostB || (isLoopback(hostA) && isLoopback(hostB))
  const same =
    sameHost &&
    originUrl.protocol === reqUrl.protocol &&
    effectivePort(originUrl) === effectivePort(reqUrl)
  const viteProxy =
    reqUrl.protocol === 'http:' &&
    originUrl.protocol === 'http:' &&
    effectivePort(reqUrl) === 3010 &&
    effectivePort(originUrl) === 5173 &&
    isLoopback(originUrl.hostname) &&
    isLoopback(reqUrl.hostname)
  return same || viteProxy
}

export async function createApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ bodyLimit: 4 * 1024 * 1024 })

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    const statusCode = err.statusCode ?? 500
    reply.code(statusCode).send({ error: err.message })
  })

  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return
    const origin = req.headers.origin
    if (!origin) {
      if (req.headers['sec-fetch-site'] === 'same-origin') return
      return reply.code(403).send({ error: 'Origin required' })
    }
    let originUrl: URL
    try {
      originUrl = new URL(origin)
    } catch {
      return reply.code(403).send({ error: 'Forbidden origin' })
    }
    const reqUrl = requestUrl(req)
    if (!reqUrl || !['http:', 'https:'].includes(originUrl.protocol)) {
      return reply.code(403).send({ error: 'Forbidden origin' })
    }
    if (!allowedOrigin(reqUrl, originUrl)) {
      return reply.code(403).send({ error: 'Forbidden origin' })
    }
  })

  // Unauthenticated on purpose: it identifies the build, nothing else, and the
  // UI needs it before a connection exists.
  app.get('/api/version', async () => ({ version: appVersion() }))

  await app.register(connectionRoutes)
  await app.register(metadataRoutes)
  await app.register(ddlRoutes)
  await app.register(queryRoutes)
  await app.register(tableEditRoutes)
  await app.register(rowUpdateRoutes)

  const webDist = fileURLToPath(new URL('../../web/dist', import.meta.url))
  if (options.serveStatic !== false && existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist })
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api')) {
        return reply.code(404).send({ error: 'Not found' })
      }
      return reply.sendFile('index.html')
    })
  }

  return app
}
