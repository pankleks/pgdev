import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The MCP shim is behaviour, not internals: a stub pgDEV API records what the
// shim forwards, and a JSON-RPC conversation over stdio pins the agent-visible
// contract (tool names, argument forwarding, token, error surfaces).

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const SHIM = join(REPO, 'bin', 'pgdev-mcp.mjs')

async function stubApi() {
  const requests = []
  let status = 200
  let closed = false
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      let parsed = {}
      try {
        parsed = JSON.parse(body || '{}')
      } catch {
        parsed = {}
      }
      requests.push({ url: req.url, auth: req.headers.authorization, body: parsed })
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify(
          status === 200
            ? { ok: true, result: { tool: req.url.split('/').pop(), args: parsed } }
            : { error: 'stub failure' },
        ),
      )
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    setStatus: (value) => {
      status = value
    },
    close: () => {
      if (closed) return Promise.resolve()
      closed = true
      return new Promise((resolve) => server.close(() => resolve()))
    },
  }
}

function startShim(env) {
  const child = spawn(process.execPath, [SHIM], {
    cwd: REPO,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let buffer = ''
  const pending = new Map()
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (!line) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      const settle = pending.get(message.id)
      if (settle) {
        pending.delete(message.id)
        settle(message)
      }
    }
  })
  let nextId = 1
  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${method}`)), 8000)
      pending.set(id, (message) => {
        clearTimeout(timer)
        resolve(message)
      })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  const notify = (method, params) =>
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  return {
    child,
    rpc,
    notify,
    stop: () => {
      child.stdin.end()
      child.kill('SIGKILL')
    },
  }
}

async function handshake(shim) {
  const init = await shim.rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'pgdev-test', version: '0' },
  })
  assert.equal(init.result.serverInfo.name, 'pgdev')
  // The agent is told what it may run and where authored writes/DDL go.
  assert.match(init.result.instructions ?? '', /read-only/)
  assert.match(init.result.instructions ?? '', /set_active_query.*open_query_tab/s)
  assert.match(init.result.instructions ?? '', /never executes staged SQL/)
  assert.match(init.result.instructions ?? '', /get_active_result/)
  shim.notify('notifications/initialized')
  return init
}

test('the shim lists the tools and forwards calls with the token', async () => {
  const api = await stubApi()
  const shim = startShim({ PGDEV_URL: api.url, PGDEV_TOKEN: 'test-token' })
  try {
    await handshake(shim)
    const list = await shim.rpc('tools/list', {})
    const names = list.result.tools.map((t) => t.name)
    assert.deepEqual(names.sort(), [
      'get_active_query',
      'get_active_result',
      'get_ddl',
      'get_schema',
      'open_query_tab',
      'query',
      'set_active_query',
    ])
    // Every tool advertises a JSON schema the agent can read.
    for (const tool of list.result.tools) {
      assert.equal(tool.inputSchema.type, 'object', tool.name)
    }
    // Connections are not part of the agent's surface, not even as a resource.
    const resources = await shim.rpc('resources/list', {})
    assert.deepEqual(resources.result.resources.map((r) => r.uri), ['pgdev://active-tab'])

    const call = await shim.rpc('tools/call', {
      name: 'get_schema',
      arguments: { table: 'items' },
    })
    const payload = JSON.parse(call.result.content[0].text)
    assert.deepEqual(payload, { tool: 'get_schema', args: { table: 'items' } })
    assert.equal(api.requests[0].auth, 'Bearer test-token')
    assert.equal(api.requests[0].url, '/api/ai/tool/get_schema')
  } finally {
    shim.stop()
    await api.close()
  }
})

test('a refused or unreachable pgDEV becomes a tool error, not a crash', async () => {
  const api = await stubApi()
  const shim = startShim({ PGDEV_URL: api.url, PGDEV_TOKEN: 'bad-token' })
  try {
    await handshake(shim)
    api.setStatus(401)
    const refused = await shim.rpc('tools/call', { name: 'query', arguments: { sql: 'SELECT 1' } })
    assert.equal(refused.result.isError, true)
    assert.match(refused.result.content[0].text, /token/)

    await api.close()
    const down = await shim.rpc('tools/call', { name: 'query', arguments: { sql: 'SELECT 1' } })
    assert.equal(down.result.isError, true)
    assert.match(down.result.content[0].text, /Cannot reach pgDEV/)

    const again = await shim.rpc('tools/list', {})
    assert.ok(again.result.tools.length > 0)
  } finally {
    shim.stop()
    await api.close()
  }
})

test('invalid arguments and unknown tools are protocol errors', async () => {
  const api = await stubApi()
  const shim = startShim({ PGDEV_URL: api.url, PGDEV_TOKEN: 't' })
  try {
    await handshake(shim)
    // get_ddl requires schema and name.
    const invalid = await shim.rpc('tools/call', { name: 'get_ddl', arguments: { type: 'table' } })
    assert.ok(invalid.error || invalid.result?.isError, JSON.stringify(invalid))

    const unknown = await shim.rpc('tools/call', { name: 'nope', arguments: {} })
    assert.ok(unknown.error || unknown.result?.isError, JSON.stringify(unknown))
  } finally {
    shim.stop()
    await api.close()
  }
})
