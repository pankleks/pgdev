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

  --port <n>     listen on this port (default 3010, or $PORT)
  --no-open      do not open a browser
  --version, -v  print the version
  --help, -h     this message

The server is served from this machine only (127.0.0.1). The database
connection is yours: nothing is sent anywhere else.`)
  process.exit(0)
}

const NO_OPEN = has('--no-open') || process.env.PGDEV_NO_OPEN === '1'
const DEFAULT_PORT = Number(valueOf('--port') ?? process.env.PORT ?? 3010)

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

// Probe-then-bind is a race: another process can take the port between
// portFree() and the server's listen(). If a child dies immediately and its
// port has since become busy, walk upward and try again — the fallback the
// probe alone cannot guarantee.
const MAX_ATTEMPTS = 20
let { port, fellBack } = await pickPort(DEFAULT_PORT)
let server = null
let childStartedAt = 0
let shuttingDown = false

function startChild() {
  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  childStartedAt = Date.now()
  child.on('error', (err) => {
    console.error(`Could not start pgDEV: ${err.message}`)
    process.exit(1)
  })
  child.on('exit', onChildExit)
  return child
}

async function onChildExit(code, signal) {
  if (shuttingDown) process.exit(0)
  // Retry only a fresh failure on a port that is now busy — never a server
  // that ran for a while; that exit code belongs to the user.
  const freshFailure = Date.now() - childStartedAt < 5000
  if (freshFailure && !(await portFree(port))) {
    const next = port + 1
    if (next >= DEFAULT_PORT + MAX_ATTEMPTS) {
      console.error(`no free port in ${DEFAULT_PORT}\u2013${DEFAULT_PORT + MAX_ATTEMPTS - 1}`)
      process.exit(1)
    }
    console.log(`Port ${port} was taken while starting; trying ${next}…`)
    ;({ port, fellBack } = { port: next, fellBack: true })
    server = startChild()
    return
  }
  // The server exits by itself when dist is missing or the port is hopeless.
  process.exit(code ?? (signal ? 1 : 0))
}

server = startChild()

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

// Wait for the server to answer before opening a browser at it. `port` is a
// let: if the child lost its port and we retried upward, polling follows it.
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
console.log(`pgDEV is running at http://localhost:${port}/`)
console.log('AI agent access (MCP) is always on — open the AI dialog in pgDEV for the MCP client config.')
console.log('Press Ctrl+C to stop.')
if (!NO_OPEN) openBrowser(`http://localhost:${port}/`)
