import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cancelClientQuery } from '../../server/dist/pgcancel.js'

const CANCEL_REQUEST_CODE = 80877102

test('cancel without backend keys sends nothing', async () => {
  // Pool clients that never connected have no processID/secretKey: the
  // request would be garbage, so it must not even open a socket.
  for (const client of [
    {},
    { processID: 4242 },
    { secretKey: 99 },
    { processID: 0, secretKey: 0, connectionParameters: { host: '127.0.0.1', port: 1 } },
  ]) {
    cancelClientQuery(client)
  }
})

test('cancel is delivered over TCP with the same 16-byte body', async () => {
  const server = net.createServer()
  const received = new Promise((resolve, reject) => {
    server.on('connection', (socket) => {
      const chunks = []
      socket.on('data', (chunk) => chunks.push(chunk))
      socket.on('end', () => resolve(Buffer.concat(chunks)))
      socket.on('error', reject)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    cancelClientQuery({
      processID: 4242,
      secretKey: 99,
      connectionParameters: { host: '127.0.0.1', port },
    })
    const buf = await received
    assert.equal(buf.length, 16)
    assert.equal(buf.readInt32BE(0), 16)
    assert.equal(buf.readInt32BE(4), CANCEL_REQUEST_CODE)
    assert.equal(buf.readInt32BE(8), 4242)
    assert.equal(buf.readInt32BE(12), 99)
  } finally {
    server.close()
  }
})

test('an SSL request the server declines ends the socket quietly', async () => {
  const server = net.createServer()
  server.on('connection', (socket) => {
    socket.once('data', (chunk) => {
      assert.equal(chunk.length, 8)
      assert.equal(chunk.readInt32BE(4), 80877103)
      socket.write(Buffer.from('N'))
    })
    socket.on('error', () => {})
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    cancelClientQuery({
      processID: 4242,
      secretKey: 99,
      connectionParameters: { host: '127.0.0.1', port, ssl: true },
    })
    await new Promise((resolve) => setTimeout(resolve, 200))
  } finally {
    server.close()
  }
})

test('cancel is delivered over a Unix-domain socket', async () => {
  // A short prefix keeps the socket path under the ~104-char platform limit.
  const dir = mkdtempSync(join(tmpdir(), 'pgdevc-'))
  const port = 5432
  const server = net.createServer()
  const received = new Promise((resolve, reject) => {
    server.on('connection', (socket) => {
      const chunks = []
      socket.on('data', (chunk) => chunks.push(chunk))
      socket.on('end', () => resolve(Buffer.concat(chunks)))
      socket.on('error', reject)
    })
  })
  await new Promise((resolve) => server.listen(join(dir, `.s.PGSQL.${port}`), resolve))
  try {
    cancelClientQuery({
      processID: 4242,
      secretKey: 99,
      connectionParameters: { host: dir, port },
    })
    const buf = await received
    assert.equal(buf.length, 16)
    assert.equal(buf.readInt32BE(0), 16)
    assert.equal(buf.readInt32BE(4), CANCEL_REQUEST_CODE)
    assert.equal(buf.readInt32BE(8), 4242)
    assert.equal(buf.readInt32BE(12), 99)
  } finally {
    server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
