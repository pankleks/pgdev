import net from 'node:net'
import tls from 'node:tls'
import type { PoolClient } from 'pg'

const CANCEL_REQUEST_CODE = 80877102
const SSL_REQUEST_CODE = 80877103

interface PgClientInternals {
  processID?: number
  secretKey?: number
  connectionParameters?: { host?: string; port?: number; ssl?: boolean | object }
}

export function cancelClientQuery(poolClient: PoolClient): void {
  const client = poolClient as unknown as PgClientInternals
  const pid = client.processID
  const secret = client.secretKey
  if (!pid || !secret) return

  const params = client.connectionParameters
  const host = params?.host || 'localhost'
  const port = params?.port || 5432
  const useSsl = Boolean(params?.ssl)

  const cancelBuf = Buffer.alloc(16)
  cancelBuf.writeInt32BE(16, 0)
  cancelBuf.writeInt32BE(CANCEL_REQUEST_CODE, 4)
  cancelBuf.writeInt32BE(pid, 8)
  cancelBuf.writeInt32BE(secret, 12)

  const socket = net.connect({ host, port })
  socket.once('error', () => socket.destroy())

  if (!useSsl) {
    socket.once('connect', () => {
      socket.end(cancelBuf, () => socket.destroy())
    })
    return
  }

  socket.once('connect', () => {
    const sslReq = Buffer.alloc(8)
    sslReq.writeInt32BE(8, 0)
    sslReq.writeInt32BE(SSL_REQUEST_CODE, 4)
    socket.write(sslReq)
  })
  socket.once('data', (chunk) => {
    if (chunk[0] !== 83) {
      socket.destroy()
      return
    }
    const tlsSocket = tls.connect({ socket, rejectUnauthorized: false }, () => {
      tlsSocket.end(cancelBuf, () => tlsSocket.destroy())
    })
    tlsSocket.once('error', () => tlsSocket.destroy())
  })
}
