import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cancelClientQuery } from '../../server/dist/pgcancel.js'

const CANCEL_REQUEST_CODE = 80877102

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
