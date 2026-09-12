#!/usr/bin/env node
// pgDEV launcher: pick a free port, start the server, open the browser, and
// shut down cleanly. This is what turns "run this command" into a double-click
// (or a single `pgdev`), for both the npm and packaged distributions.
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const args = process.argv.slice(2)
const has = (flag) => args.includes(flag)
const valueOf = (flag) => {
  const i = args.indexOf(flag)
  return i !== -1 ? args[i + 1] : undefined
}

if (has('--version') || has('-v')) {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  console.log(pkg.version)
  process.exit(0)
}
if (has('--help') || has('-h')) {
  console.log(`pgDEV — a web IDE for PostgreSQL

Usage: pgdev [options]

  --port <n>     listen on this port (default 3000, or $PORT)
  --no-open      do not open a browser
  --version, -v  print the version
  --help, -h     this message

The server is served from this machine only (127.0.0.1). The database
connection is yours: nothing is sent anywhere else.`)
  process.exit(0)
}

const NO_OPEN = has('--no-open') || process.env.PGDEV_NO_OPEN === '1'
const DEFAULT_PORT = Number(valueOf('--port') ?? process.env.PORT ?? 3000)

/** True when nothing is listening on the port. */
function portFree(port) {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', () => resolve(false))
    probe.once('listening', () => probe.close(() => resolve(true)))
    probe.listen(port, '127.0.0.1')
  })
}

/** Prefer the requested port, then walk upward so a busy port is not fatal. */
async function pickPort(preferred) {
  for (let port = preferred; port < preferred + 20; port++) {
    if (await portFree(port)) return { port, fellBack: port !== preferred }
  }
  throw new Error(`no free port in ${preferred}–${preferred + 19}`)
}

function openBrowser(url) {
  const [command, prefix] =
    process.platform === 'darwin' ? ['open', []]
      : process.platform === 'win32' ? ['cmd', ['/c', 'start', '']]
        : ['xdg-open', []]
  try {
    const child = spawn(command, [...prefix, url], { stdio: 'ignore', detached: true })
    child.on('error', () => {})
    child.unref()
  } catch {
    // Opening a browser is a convenience; failing must not stop the server.
  }
}

const entry = join(ROOT, 'server', 'dist', 'index.js')
if (!existsSync(entry)) {
  console.error('pgDEV is not built yet. Run:  npm run build')
  process.exit(1)
}

const { port, fellBack } = await pickPort(DEFAULT_PORT)
const url = `http://localhost:${port}/`

const server = spawn(process.execPath, [entry], {
  env: { ...process.env, PORT: String(port) },
  stdio: ['ignore', 'inherit', 'inherit'],
})

let shuttingDown = false
const shutdown = (signal) => {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`\npgDEV stopping${signal ? ` (${signal})` : ''}…`)
  server.kill('SIGTERM')
  // Do not wait forever for a wedged child.
  setTimeout(() => server.kill('SIGKILL'), 3000).unref()
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => shutdown(signal))
}

server.on('exit', (code, signal) => {
  if (shuttingDown) process.exit(0)
  // The server exits by itself when the port is taken or dist is missing.
  process.exit(code ?? (signal ? 1 : 0))
})
server.on('error', (err) => {
  console.error(`Could not start pgDEV: ${err.message}`)
  process.exit(1)
})

// Wait for the server to answer before opening a browser at it.
const ready = async () => {
  for (let i = 0; i < 80; i++) {
    try {
      await fetch(`http://127.0.0.1:${port}/api/version`)
      return true
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}
await ready()

if (fellBack) console.log(`Port ${DEFAULT_PORT} was busy; using ${port} instead.`)
console.log(`pgDEV is running at ${url}`)
console.log('Press Ctrl+C to stop.')
if (!NO_OPEN) openBrowser(url)
