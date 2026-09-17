import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceLoader } from '../lib/load.mjs'

const load = sourceLoader()
const { unquoteIdent, normIdent, quoteIdent, escapeSnippet, splitChain, matchDotChain, parseAliases, findRelation, resolveQualifier, findSchema } =
  await load('web/monaco/sqlrefs.ts')

test('unquoteIdent strips surrounding quotes and unescapes doubled ones', () => {
  assert.equal(unquoteIdent('abc'), 'abc')
  assert.equal(unquoteIdent('"My Col"'), 'My Col')
  assert.equal(unquoteIdent('"a""b"'), 'a"b')
})

test('normIdent folds unquoted identifiers to lower case', () => {
  // PostgreSQL is case-insensitive for unquoted identifiers only.
  assert.equal(normIdent('MyCol'), 'mycol')
  assert.equal(normIdent('"MyCol"'), 'MyCol')
})

test('quoteIdent quotes only when required', () => {
  assert.equal(quoteIdent('mycol'), 'mycol')
  assert.equal(quoteIdent('MyCol'), '"MyCol"')
  assert.equal(quoteIdent('a b'), '"a b"')
  assert.equal(quoteIdent('a"b'), '"a""b"')
  assert.equal(quoteIdent('_x9'), '_x9')
})

test('quoteIdent also quotes reserved words so inserted SQL stays valid', () => {
  assert.equal(quoteIdent('order'), '"order"')
  assert.equal(quoteIdent('SELECT'), '"SELECT"')
  assert.equal(quoteIdent('user'), '"user"')
  assert.equal(quoteIdent('window'), '"window"')
  // Non-reserved words that merely appear in clauses stay unquoted.
  assert.equal(quoteIdent('items'), 'items')
  assert.equal(quoteIdent('name'), 'name')
  assert.equal(quoteIdent('label'), 'label')
  assert.equal(quoteIdent('user_account'), 'user_account')
})

test('escapeSnippet protects snippet control characters in insert text', () => {
  assert.equal(escapeSnippet('plain'), 'plain')
  assert.equal(escapeSnippet('a$b'), 'a\\$b')
  assert.equal(escapeSnippet('a}b'), 'a\\}b')
  assert.equal(escapeSnippet('a\\b'), 'a\\\\b')
  // The `${...}` placeholder syntax is neutralised by escaping the `$`.
  assert.equal(escapeSnippet('${x}'), '\\${x\\}')
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

test('parseAliases skips long comments without truncating SQL context', () => {
  const filler = 'x'.repeat(9000)
  const a = parseAliases(`-- ${filler}\nSELECT * FROM employees e`)
  assert.deepEqual(a.get('e'), { schema: '', name: 'employees' })
})

const relations = [
  { schema: 'audit', name: 'employees' },
  { schema: 'public', name: 'employees' },
  { schema: 'Audit', name: 'Employees' },
  { schema: 'public', name: 'e' },
  { schema: 'archive', name: 'events' },
  { schema: 'audit', name: 'events' },
  { schema: 'audit', name: 'unique_table' },
]

test('unqualified lookup prefers public regardless of catalog order', () => {
  for (const list of [relations, [...relations].reverse()]) {
    assert.deepEqual(findRelation(list, { schema: '', name: 'employees' }), relations[1])
  }
  assert.equal(findRelation(relations, { schema: '', name: 'events' }), undefined)
  assert.equal(findRelation(relations, { schema: '', name: 'unique_table' }), relations[6])
})

test('qualified lookup is exact and never falls back to public', () => {
  assert.equal(findRelation(relations, { schema: 'audit', name: 'employees' }), relations[0])
  assert.equal(findRelation(relations, { schema: 'missing', name: 'employees' }), undefined)
  assert.equal(resolveQualifier(relations, ['missing', 'employees'], new Map()), undefined)
})

test('aliases retain their schema and hide the original relation name', () => {
  const aliases = parseAliases('SELECT * FROM audit.employees e WHERE e.')
  assert.equal(resolveQualifier(relations, ['e'], aliases), relations[0])
  assert.equal(resolveQualifier(relations, ['employees'], aliases), undefined)
  const bare = parseAliases('SELECT * FROM audit.employees WHERE employees.')
  assert.equal(resolveQualifier(relations, ['employees'], bare), relations[0])
  const missing = parseAliases('SELECT * FROM missing.employees e WHERE e.')
  assert.equal(resolveQualifier(relations, ['e'], missing), undefined)
  assert.equal(resolveQualifier(relations, ['employees'], missing), undefined)
})

test('quoted schemas, relations and aliases preserve case', () => {
  const aliases = parseAliases('SELECT * FROM "Audit"."Employees" AS "E" WHERE "E".')
  assert.equal(resolveQualifier(relations, ['"E"'], aliases), relations[2])
  assert.equal(resolveQualifier(relations, ['"Audit"', '"Employees"'], aliases), relations[2])
  assert.equal(resolveQualifier(relations, ['AUDIT', 'EMPLOYEES'], new Map()), relations[0])
  assert.equal(resolveQualifier(relations, ['"Audit"', 'employees'], new Map()), undefined)
  assert.equal(resolveQualifier(relations, ['e'], aliases), undefined)
})

test('quoted identifiers with escaped quotes resolve without splitting the name', () => {
  const chain = '"a""b"."c""d"'
  assert.equal(matchDotChain(`SELECT ${chain}.`), chain)
  assert.deepEqual(splitChain(chain), ['"a""b"', '"c""d"'])
  const quoted = [{ schema: 'a"b', name: 'c"d' }]
  assert.equal(resolveQualifier(quoted, splitChain(chain), new Map()), quoted[0])
  const aliases = parseAliases(`SELECT * FROM ${chain} AS "select" WHERE "select".`)
  assert.equal(resolveQualifier(quoted, ['"select"'], aliases), quoted[0])
})

test('findSchema folds unquoted parts and matches quoted ones exactly', () => {
  const schemas = ['public', 'app', 'My Schema']
  assert.equal(findSchema(schemas, 'app'), 'app')
  assert.equal(findSchema(schemas, 'APP'), 'app', 'unquoted identifiers fold to lower case')
  assert.equal(findSchema(schemas, '"app"'), 'app')
  assert.equal(findSchema(schemas, '"My Schema"'), 'My Schema')
  assert.equal(findSchema(schemas, 'My Schema'), null, 'unquoted spaces are not a schema name')
  assert.equal(findSchema(schemas, 'nope'), null)
  assert.equal(findSchema(schemas, '"App"'), null, 'quoted names are case-sensitive')
})
