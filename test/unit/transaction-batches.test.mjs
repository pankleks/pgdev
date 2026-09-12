import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../../server/dist/app.js'
import { setPool, removePool } from '../../server/dist/pools.js'
import { hasOpenTransaction } from '../../server/dist/queryshape.js'
import { splitStatements } from '../../server/dist/sqlsplit.js'

test('explicit transaction validation accounts for savepoints, chaining and comments', () => {
  for (const sql of [
    'BEGIN', 'BEGIN; UPDATE t SET x = 1',
    'START /* comment */ TRANSACTION; SELECT 1',
    'BEGIN; SAVEPOINT s; ROLLBACK TO SAVEPOINT s',
    'BEGIN; COMMIT AND CHAIN', 'ROLLBACK WORK AND CHAIN',
    'BEGIN; COMMIT; BEGIN; SELECT 1',
  ]) assert.equal(hasOpenTransaction(splitStatements(sql)), true, sql)
  for (const sql of [
    'SELECT 1', "SELECT 'BEGIN; COMMIT AND CHAIN'",
    'BEGIN; UPDATE t SET x = 1; COMMIT',
    'BEGIN; UPDATE t SET x = 1; ROLLBACK',
    'BEGIN; SAVEPOINT s; ROLLBACK TO s; END',
    'BEGIN; COMMIT AND CHAIN; ROLLBACK',
    'BEGIN; COMMIT AND NO CHAIN',
    '/* BEGIN */ SELECT 1; -- START TRANSACTION',
  ]) assert.equal(hasOpenTransaction(splitStatements(sql)), false, sql)
})

test('API rejects an unfinished transaction before acquiring a client or executing a prefix', async () => {
  const app = await createApp({ serveStatic: false })
  const id = 'unfinished-transaction-test'
  let checkouts = 0
  setPool(id, {
    async connect() { checkouts++; throw new Error('must not acquire a client') },
    async end() {},
  })
  try {
    for (const sql of [
      'BEGIN', 'BEGIN; UPDATE t SET x = 1',
      'UPDATE t SET x = 1; BEGIN',
      'BEGIN; UPDATE t SET x = 1; COMMIT; BEGIN',
      'BEGIN; SAVEPOINT s; ROLLBACK TO s',
      'COMMIT AND CHAIN',
    ]) {
      const response = await app.inject({
        method: 'POST', url: `/api/connections/${id}/query`,
        headers: { origin: 'http://localhost' }, payload: { sql },
      })
      assert.equal(response.statusCode, 400, sql)
      assert.match(response.json().error, /No statements were executed/, sql)
    }
    assert.equal(checkouts, 0)
  } finally {
    await removePool(id)
    await app.close()
  }
})

test('API still accepts complete explicit transactions and ordinary batches', async () => {
  const app = await createApp({ serveStatic: false })
  const id = 'complete-transaction-test'
  const executed = []
  const client = {
    on() {},
    removeListener() {},
    async query(query) {
      const text = typeof query === 'string' ? query : query.text
      executed.push(text)
      if (typeof query.emit === 'function') {
        queueMicrotask(() => query.emit('end', { fields: [], rows: [], command: 'OK', rowCount: 1 }))
      }
      return { fields: [], rows: [], command: 'OK', rowCount: 1 }
    },
    release() {},
  }
  setPool(id, { async connect() { return client }, async end() {} })
  try {
    for (const sql of [
      'BEGIN; UPDATE t SET x = 1; COMMIT',
      'BEGIN; UPDATE t SET x = 1; ROLLBACK',
      'BEGIN; UPDATE t SET x = 1; COMMIT AND CHAIN; ROLLBACK',
      'UPDATE t SET x = 1',
    ]) {
      executed.length = 0
      const response = await app.inject({
        method: 'POST', url: `/api/connections/${id}/query`,
        headers: { origin: 'http://localhost' }, payload: { sql },
      })
      assert.equal(response.statusCode, 200, JSON.stringify(response.json()))
      for (const stmt of splitStatements(sql)) assert.ok(executed.includes(stmt), stmt)
    }
  } finally {
    await removePool(id)
    await app.close()
  }
})
