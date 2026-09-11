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
