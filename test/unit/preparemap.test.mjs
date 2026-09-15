import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceLoader } from '../lib/load.mjs'

const load = sourceLoader()
const { findParams, mapParams, prepareScript, parseParamValues, sqlLiteral } = await load('web/lib/preparemap.ts')

// The template builder never resolves parameter types: PostgreSQL infers them
// from the query, so the scanner only needs to find the top-level $N
// references and the script only needs placeholder values.

test('finds top-level parameters once, in first-use order', () => {
  assert.deepEqual(findParams('SELECT * FROM product WHERE id = $1 AND _active = $2'), [1, 2])
  assert.deepEqual(findParams('WHERE id = $1 OR id = $1'), [1])
  assert.deepEqual(findParams('WHERE a = $1 AND b = $3'), [1, 3])
  assert.deepEqual(findParams('SELECT $2, $1'), [2, 1])
  assert.equal(findParams('SELECT 1'), null)
})

test('parameters inside literals, comments and dollar quotes are text', () => {
  const refs = findParams(
    [
      "SELECT '$1' AS note, $tag$ $2 $tag$ AS body,",
      '  -- $7 hidden',
      '  /* $3 hidden */',
      '  id = $4',
      'FROM t',
    ].join('\n'),
  )
  assert.deepEqual(refs, [4])
})

test('an identifier may contain a dollar sign', () => {
  assert.deepEqual(findParams('SELECT a$1, b$2 FROM t WHERE id = $3'), [3])
})

test('E-strings escape backslashes so quotes inside stay inside', () => {
  assert.deepEqual(findParams("SELECT E'it\\'s $1' , id = $2 FROM t"), [2])
})

test('the generated script declares no parameter types', () => {
  const sql = 'SELECT * FROM product WHERE id = $1 AND _active = $2'
  assert.equal(
    prepareScript(sql, ['0', 'TRUE']),
    [
      'PREPARE temp AS',
      '\tSELECT * FROM product WHERE id = $1 AND _active = $2;',
      '',
      '',
      'EXECUTE temp(',
      '\t0, -- $1',
      '\tTRUE -- $2',
      ');',
      '',
      '',
      'DEALLOCATE temp;',
    ].join('\n'),
  )
  assert.doesNotMatch(prepareScript(sql, ['NULL', 'NULL']), /PREPARE temp\(/)
})

test('terminators are only added when the query lacks them', () => {
  // Already terminated: untouched.
  assert.match(prepareScript('SELECT 1;', ['0']), /\tSELECT 1;\n/)
  // Trailing line comment: the `;` must not land inside the comment.
  assert.equal(
    prepareScript('SELECT 1 -- done', ['0']),
    [
      'PREPARE temp AS',
      '\tSELECT 1 -- done',
      '\t;',
      '',
      '',
      'EXECUTE temp(',
      '\t0 -- $1',
      ');',
      '',
      '',
      'DEALLOCATE temp;',
    ].join('\n'),
  )
})

test('multi-line bodies are indented under AS with tabs', () => {
  assert.equal(
    prepareScript('SELECT 1\nFROM t WHERE x = $1', ['0']),
    [
      'PREPARE temp AS',
      '\tSELECT 1',
      '\tFROM t WHERE x = $1;',
      '',
      '',
      'EXECUTE temp(',
      '\t0 -- $1',
      ');',
      '',
      '',
      'DEALLOCATE temp;',
    ].join('\n'),
  )
})

test('every parameter without a pasted value becomes NULL', () => {
  assert.equal(mapParams('SELECT 1'), null)
  const script = mapParams('WHERE a = $1 AND b = $3')
  assert.ok(script)
  assert.match(script, /\tNULL, -- \$1\n\tNULL, -- \$2\n\tNULL -- \$3/)
})

test('values arrive as JSON, optionally behind a `--` comment prefix', () => {
  const values = parseParamValues('-- [1,"assignee_employee_id_list",[10,12],false,null,["QMS Management Review"]]')
  assert.deepEqual(values, [1, 'assignee_employee_id_list', [10, 12], false, null, ['QMS Management Review']])
  assert.deepEqual(parseParamValues('  [true, null, 2.5]  '), [true, null, 2.5])
  // A bare value still maps to one parameter.
  assert.deepEqual(parseParamValues('42'), [42])
  // A pasted comment with nothing after it means "no values".
  assert.equal(parseParamValues('-- '), null)
  assert.equal(parseParamValues(''), null)
  // Invalid JSON is rejected outright.
  assert.equal(parseParamValues("[1, 'single quotes']"), null)
  assert.equal(parseParamValues('[1, "x",]'), null)
})

test('parameter values convert to SQL literals', () => {
  assert.equal(sqlLiteral(1), '1')
  assert.equal(sqlLiteral(-2.5), '-2.5')
  assert.equal(sqlLiteral("it's"), "'it''s'")
  assert.equal(sqlLiteral(false), 'FALSE')
  assert.equal(sqlLiteral(true), 'TRUE')
  assert.equal(sqlLiteral(null), 'NULL')
  assert.equal(sqlLiteral([10, 12]), 'ARRAY[10, 12]')
  assert.equal(sqlLiteral(['QMS Management Review']), "ARRAY['QMS Management Review']")
  assert.equal(sqlLiteral([]), "'{}'")
  assert.equal(sqlLiteral({ a: 1 }), "'{\"a\":1}'")
})

test('pasted JSON values replace the placeholders positionally', () => {
  const values = parseParamValues('-- [7, false]')
  const script = mapParams('SELECT * FROM t WHERE id = $1 AND _active = $2 AND tag = $3', values ?? undefined)
  assert.ok(script)
  assert.match(script, /\t7, -- \$1\n\tFALSE, -- \$2\n\tNULL -- \$3/)
})

test('shorter value arrays only override the leading parameters', () => {
  const script = mapParams('WHERE a = $1 AND b = $2', [7])
  assert.ok(script)
  assert.match(script, /\t7, -- \$1\n\tNULL -- \$2/)
})
