import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceLoader } from '../lib/load.mjs'

const {
  builtinActive,
  completionMatchesPrefix,
  functionDetail,
  functionSuggestionKey,
  objectKey,
} = await sourceLoader()('web/monaco/completekeys.ts')

// The ranking rules behind IntelliSense: which candidates survive typing,
// which same-named objects stay distinct, and when the thousands of
// built-ins may appear at all.

test('prefix characters must appear in order, case ignored', () => {
  assert.equal(completionMatchesPrefix('', 'anything'), true)
  assert.equal(completionMatchesPrefix('it', 'items'), true)
  assert.equal(completionMatchesPrefix('IT', 'items'), true)
  assert.equal(completionMatchesPrefix('js', 'json_build_object'), true)
  assert.equal(completionMatchesPrefix('xyz', 'items'), false)
  assert.equal(completionMatchesPrefix('mei', 'items'), false)
})

test('built-ins stay hidden until enough is typed', () => {
  assert.equal(builtinActive(''), false)
  assert.equal(builtinActive('j'), false)
  assert.equal(builtinActive('js'), true)
})

test('same-named functions stay distinguishable by schema and signature', () => {
  const fn = (schema, args, extra = {}) => ({
    schema, name: 'count', args, returns: 'bigint', typeSig: '', kind: 'function', oid: '1', ...extra,
  })
  assert.match(functionDetail(fn('app', 'x integer')), / · app/, 'non-public schema is named')
  assert.ok(!/ · /.test(functionDetail(fn('public', ''))), 'public stays unqualified')
  assert.ok(!/pg_catalog/.test(functionDetail(fn('pg_catalog', 'x integer'))), 'pg_catalog stays unqualified')
  assert.match(functionDetail({ ...fn('public', ''), kind: 'procedure' }), /procedure/)
  assert.match(functionDetail({ ...fn('public', ''), kind: 'aggregate' }), /aggregate/)
  const k1 = functionSuggestionKey('count', '"count"', functionDetail(fn('public', '')))
  const k2 = functionSuggestionKey('count', '"count"', functionDetail(fn('public', 'x integer')))
  const k3 = functionSuggestionKey('count', '"app"."count"', functionDetail(fn('app', '')))
  assert.notEqual(k1, k2, 'overloads are distinct suggestions')
  assert.notEqual(k1, k3, 'same-named functions in other schemas are distinct')
})

test('same-named relations in different schemas share no dedup key', () => {
  assert.notEqual(objectKey('table', 'public', 'orders'), objectKey('table', 'sales', 'orders'))
  assert.notEqual(objectKey('table', 'public', 'orders'), objectKey('view', 'public', 'orders'))
  assert.equal(objectKey('table', 'public', 'orders'), objectKey('table', 'public', 'orders'))
})
