import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceLoader } from '../lib/load.mjs'

const load = sourceLoader()
const { isReadOnlySql, wrapReadOnly } = await load('server/ai/readonly.ts')

// The agent may only run reads; the classifier exists so the common refusal is
// a clear message instead of a PostgreSQL error (the read-only transaction is
// the real guarantee, covered in apitest).

test('plain reads pass', () => {
  for (const sql of [
    'SELECT 1',
    'select * from t where id = $1',
    'WITH x AS (SELECT 1) SELECT * FROM x',
    'VALUES (1), (2)',
    'TABLE items',
    'SHOW search_path',
    'EXPLAIN SELECT * FROM t',
    'EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM t',
    '-- comment\nSELECT 1',
    '/* c */ SELECT 1',
    "SELECT 'update t set a = 1' AS note",
    'SELECT 1 -- delete from t',
    'SELECT 1 /* drop table t */',
    'SELECT $$insert into t$$ AS x',
  ]) {
    assert.deepEqual(isReadOnlySql(sql), { ok: true }, sql)
  }
})

test('writes and DDL are refused with a readable message', () => {
  for (const sql of [
    'INSERT INTO t VALUES (1)',
    'UPDATE t SET a = 1',
    'DELETE FROM t',
    'CREATE TABLE x (a int)',
    'ALTER TABLE t ADD COLUMN b int',
    'DROP TABLE t',
    'TRUNCATE t',
    'GRANT SELECT ON t TO r',
    'VACUUM t',
    'SET search_path = public',
    'CALL p()',
    'DO $$ BEGIN END $$',
    'SELECT 1; INSERT INTO t VALUES (1)',
  ]) {
    const result = isReadOnlySql(sql)
    assert.equal(result.ok, false, sql)
    assert.match(result.reason, /read-only/, sql)
  }
})

test('a data-modifying CTE passes the classifier and is left to the database', () => {
  // Masking keywords inside a CTE is not worth it: the statement starts with
  // WITH, and `BEGIN READ ONLY` refuses the write (apitest proves it).
  assert.deepEqual(isReadOnlySql('WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x'), { ok: true })
})

test('locking clauses are refused, even though they are reads', () => {
  const result = isReadOnlySql('SELECT * FROM t WHERE id = 1 FOR UPDATE')
  assert.equal(result.ok, false)
  assert.match(result.reason, /locking/i)
  // The same words inside a literal are just text.
  assert.deepEqual(isReadOnlySql("SELECT 'for update' AS note"), { ok: true })
})

test('an empty batch is refused, and reads are wrapped in a read-only transaction', () => {
  assert.equal(isReadOnlySql('   -- nothing\n').ok, false)
  assert.equal(isReadOnlySql('').ok, false)
  // The batch engine opens the transaction; the wrapper only sets its mode.
  assert.equal(wrapReadOnly('SELECT 1'), 'SET TRANSACTION READ ONLY;\nSELECT 1;')
  assert.equal(wrapReadOnly('SELECT 1;'), 'SET TRANSACTION READ ONLY;\nSELECT 1;')
  assert.equal(wrapReadOnly('  SELECT 1 ;  '), 'SET TRANSACTION READ ONLY;\nSELECT 1;')
})
