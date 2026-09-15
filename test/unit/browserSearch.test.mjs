import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceLoader } from '../lib/load.mjs'

const load = sourceLoader()
const {
  parseSearch,
  searchTerms,
  highlightTerms,
  scopedHighlight,
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

test('searchTerms makes plus an AND and a space an OR', () => {
  assert.deepEqual(searchTerms('employee+labor'), [['employee', 'labor']])
  assert.deepEqual(searchTerms('employee labor'), [['employee'], ['labor']])
  assert.deepEqual(searchTerms('user + params'), [['user'], ['params']])
  assert.deepEqual(searchTerms('a+b c+d'), [['a', 'b'], ['c', 'd']])
  assert.deepEqual(searchTerms('  '), [])
})

test('highlightTerms escapes everything and marks only the hits', () => {
  assert.equal(highlightTerms('plain', []), 'plain')
  assert.equal(
    highlightTerms("a & <b> user", [['user']]),
    'a &amp; &lt;b&gt; <mark class="search-hit">user</mark>',
  )
  // Term characters are matched literally, not as a pattern.
  assert.equal(highlightTerms('a.b', [['a.']]), '<mark class="search-hit">a.</mark>b')
  // Longer terms win so overlapping hits mark the full word.
  assert.ok(highlightTerms('params', [['param', 'params']]).includes('<mark class="search-hit">params</mark>'))
})

test('highlightTerms follows the AND/OR distinction', () => {
  // AND: the whole value must satisfy the group before anything is marked.
  assert.equal(highlightTerms('employee_id', [['employee', 'labor']]), 'employee_id')
  assert.equal(
    highlightTerms('employee_labor', [['employee', 'labor']]),
    '<mark class="search-hit">employee</mark>_<mark class="search-hit">labor</mark>',
  )
  // OR: whichever term the value contains is marked.
  assert.equal(
    highlightTerms('employee_id', [['employee'], ['labor']]),
    '<mark class="search-hit">employee</mark>_id',
  )
})

test('scopedHighlight marks only the searched section', () => {
  const orGroups = [['employee'], ['labor']]
  // A table-only search must not light up a column inside a matched table.
  assert.equal(scopedHighlight('employee_id', orGroups, 'table', ['column']), 'employee_id')
  // The same label is marked when columns are what is being searched.
  assert.equal(
    scopedHighlight('employee_id', orGroups, 'column', ['column']),
    '<mark class="search-hit">employee</mark>_id',
  )
  // An untyped search marks every section.
  assert.equal(
    scopedHighlight('employee_id', orGroups, null, ['column']),
    '<mark class="search-hit">employee</mark>_id',
  )
  // Supporting detail (empty scope) is marked only when the search is untyped.
  assert.equal(scopedHighlight('employee_id', orGroups, 'table', []), 'employee_id')
  assert.equal(
    scopedHighlight('employee_id', orGroups, null, []),
    '<mark class="search-hit">employee</mark>_id',
  )
})

test('escapeHtml neutralises markup characters', () => {
  assert.equal(escapeHtml('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;')
})

test('term matchers AND within a group and OR between groups', () => {
  assert.equal(matchesTerms('user_params', [['user', 'params']]), true)
  assert.equal(matchesTerms('user_params', [['user', 'missing']]), false)
  assert.equal(matchesTerms('employee_id', [['employee'], ['labor']]), true)
  assert.equal(matchesTerms('order_id', [['employee'], ['labor']]), false)
  assert.equal(nameMatches('items', 'public', [['item']]), true)
  assert.equal(nameMatches('items', 'archive', [['archive', 'items']]), true)
  assert.equal(columnsMatch([{ name: 'user_id' }], [['user']]), true)
  assert.equal(columnsMatch([{ name: 'label' }], [['user']]), false)
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
  assert.equal(paramsMatch('user_id integer', [['user']]), true)
  assert.equal(paramsMatch('', [['integer']]), false)
})

test('auto-expansion fires only when the name misses but the contents match', () => {
  const cols = [{ name: 'user_id' }]
  assert.equal(autoExpandRelation('items', 'public', cols, true, [['user']]), true)
  assert.equal(autoExpandRelation('user_items', 'public', cols, true, [['user']]), false)
  assert.equal(autoExpandRelation('items', 'public', cols, false, [['user']]), false)
  assert.equal(autoExpandFunction('sum', 'public', 'integer', 'user_id integer', true, [['user']]), true)
  assert.equal(autoExpandFunction('sum', 'public', 'integer', 'n integer', true, [['user']]), false)
})
