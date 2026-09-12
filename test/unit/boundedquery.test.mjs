import { test } from 'node:test'
import assert from 'node:assert/strict'
import { boundedQuery } from '../../server/dist/boundedquery.js'

test('pg row events retain only the cap, without driver-side accumulation', async () => {
  const client = {
    query(query) {
      query.handleRowDescription({ fields: [{ name: 'n', dataTypeID: 23 }] })
      for (let i = 0; i < 100000; i++) {
        query.handleDataRow({ fields: [Buffer.from(String(i))] })
      }
      query.handleCommandComplete({ text: 'SELECT 100000' }, {})
      query.handleReadyForQuery({})
    },
  }
  const bounded = await boundedQuery(client, 'SELECT n', 7)
  assert.equal(bounded.totalRowCount, 100000)
  assert.deepEqual(bounded.rows, [[0], [1], [2], [3], [4], [5], [6]])
  assert.equal(bounded.result.rows.length, 0, 'pg must not buffer discarded rows')
  assert.equal(bounded.result.rowCount, 100000)
})

test('errors after the retained rows still reject the statement', async () => {
  const failure = Object.assign(new Error('late SQL failure'), { code: '22012' })
  const client = {
    query(query) {
      query.handleRowDescription({ fields: [{ name: 'n', dataTypeID: 23 }] })
      for (let i = 0; i < 10; i++) query.handleDataRow({ fields: [Buffer.from(String(i))] })
      query.handleError(failure, {})
    },
  }
  await assert.rejects(boundedQuery(client, 'SELECT n', 2), error => error === failure)
})
