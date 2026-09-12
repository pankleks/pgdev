import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceLoader } from '../lib/load.mjs'

const load = sourceLoader()
const {
  parseSearch,
  searchTerms,
  highlightTerms,
  escapeHtml,
  matchesTerms,
  nameMatches,
  columnsMatch,
  paramsMatch,
  paramRows,
  splitArgs,
  autoExpandRelation,
  autoExpandFunction,
} = await load('web/lib/browserSearch.ts')

test('parseSearch picks the section from a trailing or leading type word', () => {
  assert.deepEqual(parseSearch(''), { term: '', type: null })
  assert.deepEqual(parseSearch('unit table'), { term: 'unit', type: 'table' })
  assert.deepEqual(parseSearch('col id'), { term: 'id', type: 'column' })
  assert.deepEqual(parseSearch('fn count'), { term: 'count', type: 'function' })
  assert.deepEqual(parseSearch('table unit'), { term: 'unit', type: 'table' })
  // A lone type word selects the section with an empty term: typing "table"
  // shows every table and nothing else.
  assert.deepEqual(parseSearch('table'), { term: '', type: 'table' })
  // "params" is a type word, so this targets the parameter sections.
  assert.deepEqual(parseSearch('User Params'), { term: 'user', type: 'parameter' })
})

test('searchTerms splits on spaces and plus signs', () => {
  assert.deepEqual(searchTerms('user + params'), ['user', 'params'])
  assert.deepEqual(searchTerms('  '), [])
})

test('highlightTerms escapes everything and marks only the hits', () => {
  assert.equal(highlightTerms('plain', []), 'plain')
  assert.equal(
    highlightTerms("a & <b> user", ['user']),
    'a &amp; &lt;b&gt; <mark class="search-hit">user</mark>',
  )
  // Term characters are matched literally, not as a pattern.
  assert.equal(highlightTerms('a.b', ['a.']), '<mark class="search-hit">a.</mark>b')
  // Longer terms win so overlapping hits mark the full word.
  assert.ok(highlightTerms('params', ['param', 'params']).includes('<mark class="search-hit">params</mark>'))
})

test('escapeHtml neutralises markup characters', () => {
  assert.equal(escapeHtml('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;')
})

test('term matchers require every term', () => {
  assert.equal(matchesTerms('user_params', ['user', 'params']), true)
  assert.equal(matchesTerms('user_params', ['user', 'missing']), false)
  assert.equal(nameMatches('items', 'public', ['item']), true)
  assert.equal(nameMatches('items', 'archive', ['archive', 'items']), true)
  assert.equal(columnsMatch([{ name: 'user_id' }], ['user']), true)
  assert.equal(columnsMatch([{ name: 'label' }], ['user']), false)
})

test('splitArgs respects quotes and nested parentheses', () => {
  assert.deepEqual(splitArgs(''), [])
  assert.deepEqual(splitArgs('a text, b integer'), ['a text', 'b integer'])
  assert.deepEqual(splitArgs("p text default 'a,b'"), ["p text default 'a,b'"])
  assert.deepEqual(splitArgs('f(nested(n1, n2)) int'), ['f(nested(n1, n2)) int'])
})

test('paramRows classifies modes and always appends the return row', () => {
  const rows = paramRows('OUT total integer, VARIADIC rest text', 'integer')
  assert.deepEqual(rows.map((r) => r.kind), ['out', 'variadic', 'returns'])
  assert.equal(rows[0].name, 'total')
  assert.equal(rows[2].rest, 'integer')
  // A bare word is a name-only parameter.
  assert.deepEqual(paramRows('flag', '')[0], { kind: 'in', name: 'flag', rest: '' })
})

test('paramsMatch ignores the returns row', () => {
  assert.equal(paramsMatch('user_id integer', ['user']), true)
  assert.equal(paramsMatch('', ['integer']), false)
})

test('auto-expansion fires only when the name misses but the contents match', () => {
  const cols = [{ name: 'user_id' }]
  assert.equal(autoExpandRelation('items', 'public', cols, true, ['user']), true)
  assert.equal(autoExpandRelation('user_items', 'public', cols, true, ['user']), false)
  assert.equal(autoExpandRelation('items', 'public', cols, false, ['user']), false)
  assert.equal(autoExpandFunction('sum', 'public', 'integer', 'user_id integer', true, ['user']), true)
  assert.equal(autoExpandFunction('sum', 'public', 'integer', 'n integer', true, ['user']), false)
})
