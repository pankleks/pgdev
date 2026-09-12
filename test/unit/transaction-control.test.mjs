import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceLoader } from '../lib/load.mjs'

const { transactionControl } = await sourceLoader()('server/queryshape.ts')

test('savepoint rollback preserves the current transaction', () => {
  for (const sql of [
    'ROLLBACK TO s', 'ROLLBACK TO SAVEPOINT s',
    'ROLLBACK WORK TO SAVEPOINT s', 'ROLLBACK TRANSACTION TO s',
    '/* before */ ROLLBACK /* nested /* comment */ */ TO "AND CHAIN"',
  ]) assert.equal(transactionControl(sql), 'unchanged', sql)
})

test('chained transaction endings leave a new transaction open', () => {
  for (const verb of ['COMMIT', 'ROLLBACK', 'END', 'ABORT']) {
    for (const optional of ['', 'WORK ', 'TRANSACTION ']) {
      assert.equal(transactionControl(`${verb} ${optional}AND CHAIN`), 'chain')
      assert.equal(transactionControl(`${verb} ${optional}AND NO CHAIN`), 'end')
      assert.equal(transactionControl(`${verb} ${optional}`), 'end')
    }
  }
  assert.equal(transactionControl('COMMIT /* x */ AND -- x\n CHAIN'), 'chain')
})

test('other statements and prepared transactions do not change local state', () => {
  for (const sql of ['SELECT 1', 'SAVEPOINT s', 'RELEASE SAVEPOINT s',
    "COMMIT PREPARED 'x'", "ROLLBACK PREPARED 'x'", "SELECT 'ROLLBACK'"]) {
    assert.equal(transactionControl(sql), 'unchanged', sql)
  }
  assert.equal(transactionControl('BEGIN'), 'start')
  assert.equal(transactionControl('START /* x */ TRANSACTION'), 'start')
})
