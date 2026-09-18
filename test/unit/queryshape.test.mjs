import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceLoader } from '../lib/load.mjs'

const load = sourceLoader()
const { withoutLeadingComments, canUseCursor, requiresAutocommit, parseMaxRows, transactionControl } =
  await load('server/queryshape.ts')

// These decide whether a batch runs inside a transaction and whether results
// are paged, so they are behaviour, not presentation.

test('withoutLeadingComments skips whitespace, line and nested block comments', () => {
  assert.equal(withoutLeadingComments('SELECT 1'), 'SELECT 1')
  assert.equal(withoutLeadingComments('   \n\tSELECT 1'), 'SELECT 1')
  assert.equal(withoutLeadingComments('-- hi\nSELECT 1'), 'SELECT 1')
  assert.equal(withoutLeadingComments('/* a /* b */ c */ SELECT 1'), 'SELECT 1')
  assert.equal(withoutLeadingComments('-- only a comment'), '')
})

test('canUseCursor accepts row-returning and WITH statements', () => {
  for (const stmt of [
    'SELECT 1',
    'VALUES (1)',
    'WITH x AS (SELECT 1) SELECT * FROM x',
    'SHOW search_path',
    'EXPLAIN SELECT 1',
    'TABLE t',
  ]) {
    assert.equal(canUseCursor(stmt), true, stmt)
  }
})

test('canUseCursor rejects statements DECLARE cannot take', () => {
  for (const stmt of [
    'INSERT INTO t VALUES (1)',
    'UPDATE t SET a = 1',
    'DELETE FROM t',
    'CREATE TABLE t (a int)',
    'DROP TABLE t',
  ]) {
    assert.equal(canUseCursor(stmt), false, stmt)
  }
})

test('canUseCursor looks past leading comments', () => {
  assert.equal(canUseCursor('-- note\nSELECT 1'), true)
  assert.equal(canUseCursor('/* note */ INSERT INTO t VALUES (1)'), false)
})

test('requiresAutocommit covers commands PostgreSQL refuses in a transaction', () => {
  for (const stmt of [
    'VACUUM FULL t',
    'VACUUM',
    'CLUSTER t',
    'CHECKPOINT',
    'CREATE DATABASE d',
    'DROP DATABASE d',
    'ALTER SYSTEM SET x = 1',
    'CREATE TABLESPACE ts LOCATION \'/x\'',
    'DROP TABLESPACE ts',
    'CREATE SUBSCRIPTION s CONNECTION \'x\' PUBLICATION p',
    'DROP SUBSCRIPTION s',
    'CREATE INDEX CONCURRENTLY i ON t (a)',
    'DROP INDEX CONCURRENTLY i',
    'REINDEX INDEX CONCURRENTLY i',
    'REFRESH MATERIALIZED VIEW CONCURRENTLY mv',
    // the IF EXISTS form must be recognised too
    'DROP DATABASE IF EXISTS d',
    'CREATE DATABASE IF NOT EXISTS d',
    'DROP TABLESPACE IF EXISTS ts',
    'DROP SUBSCRIPTION IF EXISTS s',
    'VACUUM IF EXISTS t',
  ]) {
    assert.equal(requiresAutocommit(stmt), true, stmt)
  }
})

test('requiresAutocommit leaves ordinary statements in the transaction', () => {
  for (const stmt of [
    'SELECT 1',
    'INSERT INTO t VALUES (1)',
    'CREATE TABLE t (a int)',
    'CREATE INDEX i ON t (a)',
    'DROP INDEX i',
    'REINDEX TABLE t',
    'REFRESH MATERIALIZED VIEW mv',
    'DROP TABLE IF EXISTS t',
  ]) {
    assert.equal(requiresAutocommit(stmt), false, stmt)
  }
})

test('requiresAutocommit looks past leading comments', () => {
  assert.equal(requiresAutocommit('-- maintenance\nVACUUM t'), true)
  assert.equal(requiresAutocommit('-- ordinary\nSELECT 1'), false)
})

test('requiresAutocommit survives comments between the keywords', () => {
  // A comment between CREATE and DATABASE used to defeat the regex match and
  // silently put the batch inside a transaction PostgreSQL would refuse.
  assert.equal(requiresAutocommit('CREATE /* note */ DATABASE sample'), true)
  assert.equal(requiresAutocommit('DROP /* note */ DATABASE IF EXISTS sample'), true)
  assert.equal(requiresAutocommit('CREATE /* a /* b */ */ INDEX CONCURRENTLY i ON t (a)'), true)
})

test('requiresAutocommit covers REINDEX parenthesized options', () => {
  // REINDEX's option list sits before the object keyword, so the leading word
  // run alone cannot see CONCURRENTLY.
  assert.equal(requiresAutocommit('REINDEX (VERBOSE) INDEX CONCURRENTLY i'), true)
  assert.equal(requiresAutocommit('REINDEX (CONCURRENTLY) idx'), true)
  assert.equal(requiresAutocommit('REINDEX (TABLESPACE x) idx'), false)
  assert.equal(requiresAutocommit('REINDEX INDEX "concurrently"'), false,
    'a quoted object name is data, not the CONCURRENTLY clause')
  assert.equal(requiresAutocommit('REINDEX TABLE t'), false)
})

test('requiresAutocommit never reads keywords out of literals', () => {
  // A string containing CONCURRENTLY used to flip the batch to autocommit.
  assert.equal(requiresAutocommit("CREATE INDEX i ON t WHERE note = 'CONCURRENTLY'"), false)
  assert.equal(requiresAutocommit("INSERT INTO t VALUES ('CREATE DATABASE x')"), false)
})

test('parseMaxRows enforces the documented 1–10000 range and default', () => {
  assert.equal(parseMaxRows(undefined), 500)
  assert.equal(parseMaxRows(1), 1)
  assert.equal(parseMaxRows(500), 500)
  assert.equal(parseMaxRows(10000), 10000)
  for (const bad of [0, -1, 10001, 1.5, NaN, Infinity, '500', null, {}, []]) {
    assert.equal(parseMaxRows(bad), null, JSON.stringify(bad))
  }
})

test('transactionControl: savepoint rollback preserves the transaction', () => {
  for (const sql of [
    'ROLLBACK TO s', 'ROLLBACK TO SAVEPOINT s',
    'ROLLBACK WORK TO SAVEPOINT s', 'ROLLBACK TRANSACTION TO s',
    '/* before */ ROLLBACK /* nested /* comment */ */ TO "AND CHAIN"',
  ]) assert.equal(transactionControl(sql), 'unchanged', sql)
})

test('transactionControl: chained endings and plain endings', () => {
  for (const verb of ['COMMIT', 'ROLLBACK', 'END', 'ABORT']) {
    for (const optional of ['', 'WORK ', 'TRANSACTION ']) {
      assert.equal(transactionControl(`${verb} ${optional}AND CHAIN`), 'chain')
      assert.equal(transactionControl(`${verb} ${optional}AND NO CHAIN`), 'end')
      assert.equal(transactionControl(`${verb} ${optional}`), 'end')
    }
  }
  assert.equal(transactionControl('COMMIT /* x */ AND -- x\n CHAIN'), 'chain')
  for (const sql of ['SELECT 1', 'SAVEPOINT s', 'RELEASE SAVEPOINT s',
    "COMMIT PREPARED 'x'", "ROLLBACK PREPARED 'x'", "SELECT 'ROLLBACK'"]) {
    assert.equal(transactionControl(sql), 'unchanged', sql)
  }
  assert.equal(transactionControl('BEGIN'), 'start')
  assert.equal(transactionControl('START /* x */ TRANSACTION'), 'start')
})
