import { Pool, type PoolClient } from 'pg'

const pools = new Map<string, Pool>()

// A small second pool per connection for catalog/DDL queries. Cursor sessions
// pin clients in the main pool for up to the idle timeout, so without this the
// object browser could wait out the 10s checkout timeout behind paged tabs.
const catalogPools = new Map<string, Pool>()

const runningQueries = new Map<string, PoolClient>()

export function setRunning(key: string, client: PoolClient): void {
  runningQueries.set(key, client)
}

export function getRunning(key: string): PoolClient | undefined {
  return runningQueries.get(key)
}

export function deleteRunning(key: string, client?: PoolClient): void {
  if (client) {
    // Only clear if the stored client is still ours — prevents a finished
    // query from wiping the tracking entry of a newer query on the same tab.
    if (runningQueries.get(key) === client) runningQueries.delete(key)
    return
  }
  runningQueries.delete(key)
}

export function setPool(id: string, pool: Pool): void {
  pools.set(id, pool)
}

export function getPool(id: string): Pool {
  const pool = pools.get(id)
  if (!pool) {
    const err = new Error('Unknown connection. Please reconnect.')
    ;(err as Error & { statusCode: number }).statusCode = 404
    throw err
  }
  return pool
}

export function setCatalogPool(id: string, pool: Pool): void {
  catalogPools.set(id, pool)
}

/** Catalog queries never share the main pool's client budget (see above). */
export function getCatalogPool(id: string): Pool {
  const pool = catalogPools.get(id)
  if (pool) return pool
  return getPool(id)
}

/** Keys of every running query owned by a connection (sessionKey format). */
export function runningKeysForConnection(connId: string): string[] {
  const prefix = `${connId}|`
  return [...runningQueries.keys()].filter((key) => key.startsWith(prefix))
}

export async function removePool(id: string): Promise<boolean> {
  const pool = pools.get(id)
  if (!pool) return false
  pools.delete(id)
  const catalogPool = catalogPools.get(id)
  catalogPools.delete(id)
  await Promise.all([pool.end(), catalogPool?.end().catch(() => undefined)])
  return true
}
