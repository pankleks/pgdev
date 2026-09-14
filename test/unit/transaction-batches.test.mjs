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

/** A fake pooled client that records statements and releases. */
function fakePool(options = {}) {
  const executed = []
  const state = { releases: 0, connects: 0 }
  const client = {
    on() {},
    removeListener() {},
    // Synchronous by design: boundedQuery submits a Query object and ignores
    // the return value, so a failure must throw inside its Promise executor.
    query(query) {
      const text = typeof query === 'string' ? query : query.text
      executed.push(text)
      if (options.fail && text.includes(options.fail)) throw new Error(`boom: ${text}`)
      if (typeof query.emit === 'function') {
        queueMicrotask(() => query.emit('end', { fields: [], rows: [], command: 'OK', rowCount: 1 }))
      }
      return { fields: [], rows: [], command: 'OK', rowCount: 1 }
    },
    release() {
      state.releases++
    },
  }
  return {
    executed,
    state,
    pool: {
      async connect() {
        state.connects++
        return client
      },
      async end() {},
    },
  }
}

async function withApp(id, fake, run) {
  const app = await createApp({ serveStatic: false })
  setPool(id, fake.pool)
  const inject = (sql) =>
    app.inject({
      method: 'POST',
      url: `/api/connections/${id}/query`,
      headers: { origin: 'http://localhost' },
      payload: { sql },
    })
  try {
    await run(inject)
  } finally {
    await removePool(id)
    await app.close()
  }
}

test('an unfinished transaction pins its client until COMMIT releases it', async () => {
  const fake = fakePool()
  await withApp('manual-txn-test', fake, async (inject) => {
    fake.executed.length = 0
    let response = await inject('BEGIN; UPDATE t SET x = 1')
    assert.equal(response.statusCode, 200, JSON.stringify(response.json()))
    assert.equal(response.json().transactionOpen, true)
    assert.ok(fake.executed.includes('BEGIN'), JSON.stringify(fake.executed))
    assert.ok(fake.executed.includes('UPDATE t SET x = 1'), JSON.stringify(fake.executed))
    assert.equal(fake.state.releases, 0, 'the open transaction keeps its client')
    assert.equal(fake.state.connects, 1)

    fake.executed.length = 0
    response = await inject('COMMIT')
    assert.equal(response.statusCode, 200, JSON.stringify(response.json()))
    assert.equal(response.json().transactionOpen, false)
    assert.ok(fake.executed.includes('COMMIT'), JSON.stringify(fake.executed))
    assert.equal(fake.state.releases, 1, 'COMMIT ends the session and releases the client')
  })
})

test('COMMIT AND CHAIN keeps a transaction open and ROLLBACK closes it', async () => {
  const fake = fakePool()
  await withApp('chain-txn-test', fake, async (inject) => {
    let response = await inject('BEGIN; UPDATE t SET x = 1')
    assert.equal(response.json().transactionOpen, true)

    response = await inject('COMMIT AND CHAIN')
    assert.equal(response.statusCode, 200, JSON.stringify(response.json()))
    assert.equal(response.json().transactionOpen, true, 'a chained commit opens a new transaction')
    assert.equal(fake.state.releases, 0)

    response = await inject('ROLLBACK')
    assert.equal(response.statusCode, 200)
    assert.equal(response.json().transactionOpen, false)
    assert.equal(fake.state.releases, 1)
  })
})

test('a failed statement inside an open transaction keeps it open for ROLLBACK', async () => {
  const fake = fakePool({ fail: 'explode' })
  await withApp('aborted-txn-test', fake, async (inject) => {
    let response = await inject('BEGIN; UPDATE t SET x = 1')
    assert.equal(response.json().transactionOpen, true)

    response = await inject('SELECT explode()')
    assert.equal(response.statusCode, 400)
    assert.match(response.json().error, /boom/)
    assert.equal(fake.state.releases, 0, 'the aborted transaction is still pinned')

    response = await inject('ROLLBACK')
    assert.equal(response.statusCode, 200)
    assert.equal(response.json().transactionOpen, false)
    assert.equal(fake.state.releases, 1)
  })
})

test('an error in the batch that opened the transaction rolls it back immediately', async () => {
  const fake = fakePool({ fail: 'explode' })
  await withApp('opening-error-test', fake, async (inject) => {
    const response = await inject('BEGIN; SELECT explode()')
    assert.equal(response.statusCode, 400)
    assert.match(response.json().error, /boom/)
    assert.equal(fake.state.releases, 1, 'nothing stays pinned after the opening batch failed')
    assert.ok(fake.executed.includes('ROLLBACK'), JSON.stringify(fake.executed))

    // The tab is clean again: the next batch checks out a fresh client.
    const next = await inject('SELECT 1')
    assert.equal(next.statusCode, 200)
    assert.equal(fake.state.connects, 2)
  })
})

test('API still accepts complete explicit transactions and ordinary batches', async () => {
  const fake = fakePool()
  await withApp('complete-transaction-test', fake, async (inject) => {
    for (const sql of [
      'BEGIN; UPDATE t SET x = 1; COMMIT',
      'BEGIN; UPDATE t SET x = 1; ROLLBACK',
      'BEGIN; UPDATE t SET x = 1; COMMIT AND CHAIN; ROLLBACK',
      'UPDATE t SET x = 1',
    ]) {
      fake.executed.length = 0
      const response = await inject(sql)
      assert.equal(response.statusCode, 200, JSON.stringify(response.json()))
      assert.equal(response.json().transactionOpen, false, sql)
      for (const stmt of splitStatements(sql)) assert.ok(fake.executed.includes(stmt), stmt)
    }
  })
})
