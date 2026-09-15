import { createApp } from './app.js'

// PGDEV_AI=1 (or --ai) exposes the MCP tool surface; the launcher sets it.
const ai = process.env.PGDEV_AI === '1' || process.argv.includes('--ai')
const app = await createApp({ ai })
const port = Number(process.env.PORT) || 3010
await app.listen({ port, host: '127.0.0.1' })
console.log(`pgDEV server listening on http://localhost:${port}${ai ? ' (AI tools enabled)' : ''}`)
