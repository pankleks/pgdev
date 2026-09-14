import { createApp } from './app.js'

const app = await createApp()
const port = Number(process.env.PORT) || 3010
await app.listen({ port, host: '127.0.0.1' })
console.log(`pgDEV server listening on http://localhost:${port}`)
