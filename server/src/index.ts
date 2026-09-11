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

function hostOnly(hostHeader: string): string {
  const h = hostHeader.split(',')[0].trim()
  if (h.startsWith('[')) return h.slice(1, h.indexOf(']') === -1 ? undefined : h.indexOf(']'))
  return h.split(':')[0]
}

function isLoopback(host: string): boolean {
  const h = host.toLowerCase()
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.localhost')
}

// Drive-by protection: the API has no auth and happily dials databases,
// so a malicious website must not be able to drive it through the user's
// browser. Browser fetches always carry an Origin header — require it to
// match the request host (loopback aliases are interchangeable). Requests
// without Origin (curl, server-side tools) are unaffected.
app.addHook('onRequest', async (req, reply) => {
  if (!req.url.startsWith('/api/')) return
  const origin = req.headers.origin
  if (!origin) return
  let originHost: string
  try {
    originHost = new URL(origin).hostname
  } catch {
    return reply.code(403).send({ error: 'Forbidden origin' })
  }
  const hostHost = hostOnly(String(req.headers.host ?? ''))
  const same = originHost.toLowerCase() === hostHost.toLowerCase()
  if (!same && !(isLoopback(originHost) && isLoopback(hostHost))) {
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
