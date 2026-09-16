import { createApp } from './app.js'

// The agent's token lives in a per-user file by default; an explicit path
// (tests, containers with a read-only home) overrides it.
const app = await createApp({ aiTokenFile: process.env.PGDEV_TOKEN_FILE })
const port = Number(process.env.PORT) || 3010
await app.listen({ port, host: '127.0.0.1' })
console.log(`pgDEV server listening on http://localhost:${port}`)
