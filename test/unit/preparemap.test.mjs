import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceLoader } from '../lib/load.mjs'

const load = sourceLoader()
const { findParams, mapParams, paramDefaultValue, paramTypeOf, prepareScript, parseParamValues, sqlLiteral } =
  await load('web/lib/preparemap.ts')

test('finds parameters with their comparison context', () => {
  const refs = findParams('SELECT * FROM product WHERE id = $1 AND _active = $2')
  assert.deepEqual(refs, [
    { index: 1, column: 'id', qualifier: null, operator: '=' },
    { index: 2, column: '_active', qualifier: null, operator: '=' },
  ])
})

test('captures dotted qualifiers but not bare call names', () => {
  assert.deepEqual(findParams('SELECT * FROM t p WHERE p.id > $1'), [
    { index: 1, column: 'id', qualifier: 'p', operator: '>' },
  ])
  assert.deepEqual(findParams('SELECT * FROM t WHERE f($1) OR price = $2'), [
    { index: 1, column: null, qualifier: null, operator: null },
    { index: 2, column: 'price', qualifier: null, operator: '=' },
  ])
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
  assert.deepEqual(refs.map((r) => r.index), [4])
  assert.equal(refs[0].column, 'id')
})

test('repeated parameters appear once and gaps are tolerated by mapParams', () => {
  assert.deepEqual(findParams('WHERE id = $1 OR id = $1').map((r) => r.index), [1])
  const mapped = mapParams('WHERE a = $1 AND b = $3', () => null)
  assert.ok(mapped)
  assert.equal(mapped.typed, false)
  assert.match(mapped.script, /NULL, -- \$2/)
})

test('E-strings escape backslashes so quotes inside stay inside', () => {
  const refs = findParams("SELECT E'it\\'s $1' , id = $2 FROM t")
  assert.deepEqual(refs.map((r) => r.index), [2])
})

test('the generated script matches the agreed shape', () => {
  const sql = 'SELECT * FROM product WHERE id = $1 AND _active = $2'
  const script = prepareScript(sql, ['integer', 'boolean'], ['0', 'TRUE'])
  assert.equal(
    script,
    [
      'PREPARE temp(integer, boolean) AS',
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
})

test('terminators are only added when the query lacks them', () => {
  // Already terminated: untouched.
  assert.match(prepareScript('SELECT 1;', ['integer'], ['0']), /\tSELECT 1;\n/)
  // Trailing line comment: the `;` must not land inside the comment.
  assert.equal(
    prepareScript('SELECT 1 -- done', ['integer'], ['0']),
    [
      'PREPARE temp(integer) AS',
      '\tSELECT 1 -- done',
      '\t;',
      '',
      '',
      'EXECUTE temp(',
      "\t0 -- $1",
      ');',
      '',
      '',
      'DEALLOCATE temp;',
    ].join('\n'),
  )
})

test('mapParams types every parameter when the resolver answers', () => {
  const mapped = mapParams('SELECT * FROM product WHERE id = $1 AND _active = $2', (ref) => {
    if (ref.column === 'id') return paramTypeOf('integer')
    if (ref.column === '_active') return paramTypeOf('boolean')
    return null
  })
  assert.ok(mapped)
  assert.equal(mapped.typed, true)
  assert.match(mapped.script, /^PREPARE temp\(integer, boolean\) AS\n\tSELECT/)
  assert.match(mapped.script, /\tTRUE -- \$2\n\)/)
})

test('any unresolvable parameter drops the type list but keeps typed values', () => {
  const mapped = mapParams('SELECT * FROM product WHERE id = $1 AND name = $2', (ref) =>
    ref.column === 'id' ? paramTypeOf('integer') : null,
  )
  assert.ok(mapped)
  assert.equal(mapped.typed, false)
  assert.match(mapped.script, /^PREPARE temp AS/)
  assert.match(mapped.script, /\t0, -- \$1/)
  assert.match(mapped.script, /\tNULL -- \$2/)
})

test('multi-line bodies are indented under AS with tabs', () => {
  const script = prepareScript('SELECT 1\nFROM t WHERE x = $1', ['integer'], ['0'])
  assert.equal(
    script,
    [
      'PREPARE temp(integer) AS',
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

test('no parameters means no script', () => {
  assert.equal(findParams('SELECT 1'), null)
  assert.equal(mapParams('SELECT 1', () => paramTypeOf('integer')), null)
})

test('placeholder defaults follow the resolved type family', () => {
  assert.equal(paramDefaultValue('integer'), '0')
  assert.equal(paramDefaultValue('numeric(10,2)'), '0')
  assert.equal(paramDefaultValue('boolean'), 'TRUE')
  assert.equal(paramDefaultValue('character varying(256)'), "''")
  assert.equal(paramDefaultValue('timestamp with time zone'), "'now'")
  assert.equal(paramDefaultValue('jsonb'), "'{}'")
  assert.equal(paramDefaultValue('bytea'), 'NULL')
  assert.deepEqual(paramTypeOf('numeric(10,2)'), { ddl: 'numeric', value: '0' })
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

test('pasted JSON values replace the inferred placeholders positionally', () => {
  const values = parseParamValues('-- [7, false]')
  const mapped = mapParams(
    'SELECT * FROM t WHERE id = $1 AND _active = $2 AND tag = $3',
    (ref) =>
      ref.column === 'id'
        ? paramTypeOf('integer')
        : ref.column === '_active'
          ? paramTypeOf('boolean')
          : ref.column === 'tag'
            ? paramTypeOf('text')
            : null,
    values ?? undefined,
  )
  assert.ok(mapped)
  assert.equal(mapped.typed, true)
  assert.match(mapped.script, /\t7, -- \$1/)
  assert.match(mapped.script, /\tFALSE, -- \$2/)
  // The type list is untouched by the values.
  assert.match(mapped.script, /^PREPARE temp\(integer, boolean, text\) AS/)
})

test('shorter value arrays only override the leading parameters', () => {
  const mapped = mapParams('WHERE a = $1 AND b = $2', () => paramTypeOf('text'), [7])
  assert.ok(mapped)
  assert.match(mapped.script, /\t7, -- \$1/)
  assert.match(mapped.script, /'' -- \$2/)
})
