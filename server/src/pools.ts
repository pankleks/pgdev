import { Pool, type PoolClient } from 'pg'

const pools = new Map<string, Pool>()

const runningQueries = new Map<string, PoolClient>()

export function setRunning(key: string, client: PoolClient): void {
  runningQueries.set(key, client)
}

export function getRunning(key: string): PoolClient | undefined {
  return runningQueries.get(key)
}

export function deleteRunning(key: string): void {
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

export async function removePool(id: string): Promise<boolean> {
  const pool = pools.get(id)
  if (!pool) return false
  pools.delete(id)
  await pool.end()
  return true
}
