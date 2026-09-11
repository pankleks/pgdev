import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { connectionRoutes } from './routes/connections.js'
import { metadataRoutes } from './routes/metadata.js'
import { ddlRoutes } from './routes/ddl.js'
import { queryRoutes } from './routes/query.js'

const app = Fastify({ bodyLimit: 4 * 1024 * 1024 })

app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
  const statusCode = err.statusCode ?? 500
  reply.code(statusCode).send({ error: err.message })
})

function isLoopback(host: string): boolean {
  const h = host.toLowerCase()
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.localhost')
}

function effectivePort(url: URL): number {
  return Number(url.port) || (url.protocol === 'https:' ? 443 : 80)
}

function requestUrl(req: { protocol: string; headers: { host?: string } }): URL | null {
  try {
    return new URL(`${req.protocol}://${String(req.headers.host ?? '')}`)
  } catch {
    return null
  }
}

function allowedOrigin(reqUrl: URL, originUrl: URL): boolean {
  const same =
    originUrl.hostname.toLowerCase() === reqUrl.hostname.toLowerCase() &&
    originUrl.protocol === reqUrl.protocol &&
    effectivePort(originUrl) === effectivePort(reqUrl)
  const viteProxy =
    reqUrl.protocol === 'http:' &&
    originUrl.protocol === 'http:' &&
    effectivePort(reqUrl) === 3000 &&
    effectivePort(originUrl) === 5173 &&
    isLoopback(originUrl.hostname) &&
    isLoopback(reqUrl.hostname)
  return same || viteProxy
}

// Drive-by protection: the API has no auth and happily dials databases,
// so a malicious website must not be able to drive it through the user's
// browser. Browser fetches must carry an Origin matching the full request
// origin. Same-origin GETs may omit Origin, so the browser-controlled
// Sec-Fetch-Site header is accepted for that case. The Vite dev proxy is the
// one intentional cross-port exception.
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

await app.register(connectionRoutes)
await app.register(metadataRoutes)
await app.register(ddlRoutes)
await app.register(queryRoutes)

const webDist = fileURLToPath(new URL('../../web/dist', import.meta.url))
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist })
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api')) {
      return reply.code(404).send({ error: 'Not found' })
    }
    return reply.sendFile('index.html')
  })
}

const port = Number(process.env.PORT) || 3000
await app.listen({ port, host: '127.0.0.1' })
console.log(`pgdev server listening on http://localhost:${port}`)
