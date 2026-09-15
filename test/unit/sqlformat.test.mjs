import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceLoader } from '../lib/load.mjs'

const load = sourceLoader()
const { formatSql } = await load('web/lib/sqlformat.ts')

// sql-formatter only knows its own PostgreSQL function list, so user-defined
// and schema-qualified calls used to gain a space (`fn ($1)`). The wrapper
// collects the names the query calls and keeps them tight, while clause
// keywords and quoted text must not be touched.

test('user function calls keep their name tight to the parenthesis', () => {
  assert.equal(
    formatSql('select employee_has_any_role($5::INTEGER, role_id_list) from employee'),
    'SELECT\n\temployee_has_any_role($5::INTEGER, role_id_list)\nFROM\n\temployee',
  )
  assert.equal(
    formatSql('select foo(a, b) from t'),
    'SELECT\n\tfoo(a, b)\nFROM\n\tt',
  )
})

test('schema-qualified calls are tightened too', () => {
  assert.equal(
    formatSql('select pg_catalog.entry_has_role($1, $2) from t'),
    'SELECT\n\tpg_catalog.entry_has_role($1, $2)\nFROM\n\tt',
  )
  assert.equal(
    formatSql('select pg_catalog.count(*) from t'),
    'SELECT\n\tpg_catalog.count(*)\nFROM\n\tt',
  )
})

test('built-in functions are unchanged', () => {
  assert.equal(formatSql('select count(*) from t'), 'SELECT\n\tcount(*)\nFROM\n\tt')
  assert.equal(formatSql('select to_char(now())'), 'SELECT\n\tto_char(now())')
})

test('clause keywords keep their space before the parenthesis', () => {
  const where = formatSql('select * from t where id in (1,2)')
  assert.match(where, /IN \(1, 2\)/)
  const window = formatSql('select row_number() over (partition by a) from t')
  assert.match(window, /OVER \(/)
  const filtered = formatSql('select array_agg(x) filter (where x > 1) from t')
  assert.match(filtered, /FILTER \(/)
  const values = formatSql('insert into t values (1), (2)')
  assert.match(values, /VALUES\n\t\(1\)/)
})

test('strings and comments are never rewritten', () => {
  const sql = "select foo('a (b') from t -- foo( comment"
  const out = formatSql(sql)
  assert.match(out, /foo\('a \(b'\)/)
  assert.match(out, /-- foo\( comment/)
})

test('calls already written with a space are normalised', () => {
  assert.match(formatSql('select my_schema.my_func (a) from t'), /my_schema\.my_func\(a\)/)
  assert.match(formatSql('select employee_has_any_role (a) from t'), /employee_has_any_role\(a\)/)
})

test('JSON arrows keep no space around them', () => {
  assert.equal(
    formatSql("select dr.field_bag ->> 'level' from dr_table dr"),
    "SELECT\n\tdr.field_bag->>'level'\nFROM\n\tdr_table dr",
  )
  assert.equal(
    formatSql("select a -> 'b' -> 'c' from t"),
    "SELECT\n\ta->'b'->'c'\nFROM\n\tt",
  )
  assert.equal(
    formatSql("select a #> '{x,y}' #>> '{x}' from t"),
    "SELECT\n\ta#>'{x,y}'#>>'{x}'\nFROM\n\tt",
  )
  // A negative index is an operand, not another arrow.
  assert.equal(formatSql('select data -> -1 from t'), 'SELECT\n\tdata->-1\nFROM\n\tt')
})

test('arrows inside strings and comments are never rewritten', () => {
  const out = formatSql("select 'a -> b' as s from t -- x ->> y")
  assert.match(out, /'a -> b'/)
  assert.match(out, /-- x ->> y/)
})

test('routine bodies are tightened while plain dollar literals survive', () => {
  const routine =
    'CREATE FUNCTION f() RETURNS void AS $$ BEGIN PERFORM employee_has_any_role($1); END $$ LANGUAGE plpgsql;'
  const out = formatSql(routine)
  assert.match(out, /employee_has_any_role\(\$1\)/)
  assert.equal(formatSql('SELECT $$literal foo( $$;'), 'SELECT $$literal foo( $$;')
})
