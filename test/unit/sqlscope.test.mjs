import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceLoader } from '../lib/load.mjs'

const load = sourceLoader()
const { resolveQueryScope } = await load('web/monaco/sqlscope.ts')
const { resolveQualifier } = await load('web/monaco/sqlrefs.ts')

function scope(marked) {
  const offset = marked.indexOf('|')
  assert.notEqual(offset, -1, 'fixture needs a cursor')
  return resolveQueryScope(marked.replace('|', ''), offset)
}
function refs(marked) {
  return Object.fromEntries(scope(marked).aliases)
}
const ref = (name, schema = '') => ({ schema, name })

test('plain JOIN is not consumed as an alias; all joined sources resolve', () => {
  assert.deepEqual(refs('SELECT | FROM a JOIN b ON a.id=b.id JOIN c ON true'), {
    a: ref('a'), b: ref('b'), c: ref('c'),
  })
})

test('completion in the SELECT list sees aliases declared after the cursor', () => {
  assert.deepEqual(refs('SELECT u.| FROM app.users AS u'), { u: ref('users', 'app') })
})

test('both ends of a statement see the same bindings', () => {
  assert.deepEqual(refs('SELECT |u.id FROM users u WHERE true'), refs('SELECT u.id FROM users u WHERE true|'))
})

test('only the cursor statement contributes bindings, including semicolon boundaries', () => {
  assert.deepEqual(refs('SELECT * FROM old o; SELECT x.| FROM current x; SELECT * FROM later x'), { x: ref('current') })
  assert.deepEqual(refs('SELECT * FROM old o|; SELECT * FROM later x'), { o: ref('old') })
  assert.deepEqual(refs('SELECT * FROM old o;|'), {})
})

test('comments and literals cannot declare aliases or split statements', () => {
  assert.deepEqual(refs("SELECT 'JOIN fake x; FROM bad' FROM real x /* JOIN wrong x; /* nested */ */ -- JOIN nope x;\nWHERE |"), { x: ref('real') })
  assert.deepEqual(refs('SELECT $$ FROM fake x; $$ FROM real x WHERE |'), { x: ref('real') })
  assert.deepEqual(refs("SELECT E'escaped\\\' JOIN fake x;' FROM real x WHERE |"), { x: ref('real') })
})

test('comments are accepted between schema, relation, AS and alias tokens', () => {
  assert.deepEqual(refs('SELECT x.| FROM app /* note */ . users AS /* alias */ x'), { x: ref('users', 'app') })
})

test('identifiers use lexer rules for Unicode, dollars, quoted case and escapes', () => {
  assert.deepEqual(refs('SELECT | FROM café café$1 JOIN "My Schema"."a""b" AS "X" ON true'), {
    café$1: ref('café'), X: ref('a"b', 'My Schema'),
  })
})

test('comma FROM sources and keyword aliases are handled independently', () => {
  assert.deepEqual(refs('SELECT | FROM a, app.b AS b LEFT JOIN c ON true WHERE true'), {
    a: ref('a'), b: ref('b', 'app'), c: ref('c'),
  })
  assert.deepEqual(refs('SELECT | FROM a AS "where"'), { where: ref('a') })
})

test('inner aliases shadow outer bindings and siblings stay out of scope', () => {
  assert.deepEqual(refs('SELECT * FROM outer_table x WHERE EXISTS (SELECT x.| FROM inner_table x) AND EXISTS (SELECT * FROM sibling s)'), {
    x: ref('inner_table'),
  })
  assert.deepEqual(refs('SELECT x.| FROM outer_table x WHERE EXISTS (SELECT * FROM inner_table x)'), { x: ref('outer_table') })
})

test('correlated subqueries inherit enclosing bindings through expression groups', () => {
  assert.deepEqual(refs('SELECT * FROM outer_table o WHERE ((EXISTS (SELECT | FROM inner_table i)))'), {
    o: ref('outer_table'), i: ref('inner_table'),
  })
})

test('unfinished subqueries still resolve later FROM and outer aliases', () => {
  assert.deepEqual(refs('SELECT * FROM outer_table o WHERE EXISTS (SELECT i.| FROM inner_table i'), {
    o: ref('outer_table'), i: ref('inner_table'),
  })
})

test('set operation arms have independent relation namespaces', () => {
  assert.deepEqual(refs('SELECT x.| FROM first_table x UNION ALL SELECT * FROM second_table x'), { x: ref('first_table') })
  assert.deepEqual(refs('SELECT * FROM first_table x UNION ALL SELECT y.| FROM second_table y'), { y: ref('second_table') })
})

test('CTE internals do not leak into the main query, nor the main FROM into a CTE', () => {
  assert.deepEqual(refs('WITH recent AS (SELECT * FROM events e) SELECT r.| FROM recent r'), { r: ref('') })
  assert.deepEqual(refs('WITH recent AS (SELECT e.| FROM events e) SELECT * FROM recent r JOIN users u ON true'), { e: ref('events') })
})

test('derived relations shadow catalog tables even before output inference exists', () => {
  const result = scope('SELECT d.| FROM (SELECT * FROM events e) d')
  assert.equal(result.hasRelations, true)
  assert.deepEqual([...result.aliases], [['d', ref('')]])
  assert.equal(resolveQualifier([{ schema: 'public', name: 'd' }], ['d'], result.aliases), undefined)
  assert.equal(scope('SELECT | FROM (SELECT 1)').hasRelations, true)
})

test('non-LATERAL FROM subqueries cannot see sibling sources', () => {
  assert.deepEqual(refs('SELECT * FROM users u JOIN (SELECT e.| FROM events e) d ON true'), { e: ref('events') })
})

test('LATERAL subqueries see preceding sources, not later siblings or themselves', () => {
  assert.deepEqual(refs('SELECT * FROM users u JOIN LATERAL (SELECT e.| FROM events e) d ON true JOIN later l ON true'), {
    u: ref('users'), e: ref('events'),
  })
})

test('FROM-like words inside identifiers and expression functions are not sources', () => {
  assert.deepEqual(refs('SELECT substring(x FROM 1), "FROM", from_here FROM actual a WHERE |'), { a: ref('actual') })
})

test('DISTINCT FROM operators and array commas do not introduce sources', () => {
  assert.deepEqual(refs('SELECT | FROM users u WHERE u.name IS DISTINCT FROM other_name'), { u: ref('users') })
  assert.deepEqual(refs('SELECT u.id IS NOT DISTINCT FROM other_id FROM users u WHERE |'), { u: ref('users') })
  assert.deepEqual(refs('SELECT | FROM a JOIN b ON a.ids && ARRAY[b.id, phantom.id]'), { a: ref('a'), b: ref('b') })
})

test('long statements retain bindings more than 8000 characters from the cursor', () => {
  assert.deepEqual(refs(`SELECT * FROM users u WHERE /* ${'x'.repeat(9000)} */ u.|`), { u: ref('users') })
})

test('routine body statements are isolated and unfinished bodies work at EOF', () => {
  assert.deepEqual(refs('CREATE FUNCTION f() RETURNS void AS $$ BEGIN SELECT * FROM old o; SELECT u.| FROM users u; END $$ LANGUAGE plpgsql;'), { u: ref('users') })
  assert.deepEqual(refs('DO $$ BEGIN SELECT * FROM users u WHERE u.|'), { u: ref('users') })
})
