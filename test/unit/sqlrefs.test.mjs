import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceLoader } from '../lib/load.mjs'

const load = sourceLoader()
const { unquoteIdent, normIdent, quoteIdent, splitChain, matchDotChain, parseAliases } =
  await load('web/monaco/sqlrefs.ts')

test('unquoteIdent strips surrounding quotes and unescapes doubled ones', () => {
  assert.equal(unquoteIdent('abc'), 'abc')
  assert.equal(unquoteIdent('"My Col"'), 'My Col')
  assert.equal(unquoteIdent('"a""b"'), 'a"b')
})

test('normIdent folds unquoted identifiers to lower case', () => {
  // PostgreSQL is case-insensitive for unquoted identifiers only.
  assert.equal(normIdent('MyCol'), 'mycol')
  assert.equal(normIdent('"MyCol"'), 'mycol')
})

test('quoteIdent quotes only when required', () => {
  assert.equal(quoteIdent('mycol'), 'mycol')
  assert.equal(quoteIdent('MyCol'), '"MyCol"')
  assert.equal(quoteIdent('a b'), '"a b"')
  assert.equal(quoteIdent('a"b'), '"a""b"')
  assert.equal(quoteIdent('_x9'), '_x9')
})

test('splitChain keeps quoted segments intact', () => {
  assert.deepEqual(splitChain('sch."My Table".col'), ['sch', '"My Table"', 'col'])
  assert.deepEqual(splitChain('t'), ['t'])
})

test('matchDotChain detects only a trailing qualifier', () => {
  assert.equal(matchDotChain('SELECT e.'), 'e')
  assert.equal(matchDotChain('SELECT sch.tbl.'), 'sch.tbl')
  assert.equal(matchDotChain('SELECT e'), null)
  assert.equal(matchDotChain('SELECT "My T".'), '"My T"')
})

test('parseAliases maps aliases and bare relation names', () => {
  const a = parseAliases('SELECT * FROM sch.employees e JOIN departments ON true')
  assert.deepEqual(a.get('e'), { schema: 'sch', name: 'employees' })
  assert.deepEqual(a.get('departments'), { schema: '', name: 'departments' })
})

test('parseAliases handles AS and ignores keywords', () => {
  const a = parseAliases('SELECT * FROM employees AS e WHERE')
  assert.deepEqual(a.get('e'), { schema: '', name: 'employees' })
  assert.equal(a.has('where'), false)
})

test('parseAliases bounds its work on very large inputs', () => {
  const filler = 'x'.repeat(9000)
  const a = parseAliases(`-- ${filler}\nSELECT * FROM employees e`)
  assert.deepEqual(a.get('e'), { schema: '', name: 'employees' })
})
