import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceLoader } from '../lib/load.mjs'

const load = sourceLoader()
const { formatSql } = await load('web/lib/sqlformat.ts')

// sql-formatter only knows its own PostgreSQL function list, so user-defined
// and schema-qualified calls used to gain a space (`fn ($1)`). The wrapper
// collects the names the query calls and keeps them tight, while clause
// keywords and quoted text must not be touched.

test('calls stay tight to the parenthesis', () => {
  // sql-formatter only knows its own function list; user-defined,
  // schema-qualified and keyword-named calls used to gain a space (`fn ($1)`).
  const tight = [
    ['select employee_has_any_role($5::INTEGER, role_id_list) from employee', /employee_has_any_role\(\$5::INTEGER, role_id_list\)/],
    ['select foo(a, b) from t', /foo\(a, b\)/],
    ['select pg_catalog.entry_has_role($1, $2) from t', /pg_catalog\.entry_has_role\(\$1, \$2\)/],
    ['select pg_catalog.count(*) from t', /pg_catalog\.count\(\*\)/],
    ['select * from t where id = any($6)', /ANY\(\$6\)/],
    ['select * from t where id = all($6)', /ALL\(\$6\)/],
    ['select any(array[1, 2])', /ANY\(ARRAY\[1, 2\]\)/],
    ['select * from t where id in($6)', /IN\(\$6\)/],
    ['select my_schema.my_func (a) from t', /my_schema\.my_func\(a\)/],
    ['select employee_has_any_role (a) from t', /employee_has_any_role\(a\)/],
    ['select * from t where id = any ($6)', /ANY\(\$6\)/],
    ['select * from t where id in ($6)', /IN\(\$6\)/],
  ]
  for (const [sql, want] of tight) assert.match(formatSql(sql), want, sql)
})

test('built-in functions are unchanged', () => {
  assert.equal(formatSql('select count(*) from t'), 'SELECT\n\tcount(*)\nFROM\n\tt')
  assert.equal(formatSql('select to_char(now())'), 'SELECT\n\tto_char(now())')
})

test('no space before an opening parenthesis, in every construct', () => {
  assert.equal(
    formatSql('select * from t where id in (1,2)'),
    'SELECT\n\t*\nFROM\n\tt\nWHERE\n\tid IN(1, 2)',
  )
  assert.equal(
    formatSql('select count(*) filter (where x > 1) from t'),
    'SELECT\n\tcount(*) FILTER(\n\t\tWHERE\n\t\t\tx > 1\n\t)\nFROM\n\tt',
  )
  assert.equal(
    formatSql('select * from t where exists (select 1)'),
    'SELECT\n\t*\nFROM\n\tt\nWHERE\n\tEXISTS(\n\t\tSELECT\n\t\t\t1\n\t)',
  )
  assert.equal(
    formatSql('insert into t (a, b) values (1, 2)'),
    'INSERT INTO\n\tt(a, b)\nVALUES\n\t(1, 2)',
  )
  assert.equal(formatSql('create index on t (a)'), 'CREATE INDEX ON t(a)')
})

test('strings and comments are never rewritten', () => {
  const sql = "select foo('a (b') from t -- foo( comment"
  const out = formatSql(sql)
  assert.match(out, /foo\('a \(b'\)/)
  assert.match(out, /-- foo\( comment/)
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

test('a GUC spelling inside a literal never flips the scanning mode', () => {
  // The formatter tracks standard_conforming_strings per statement; a string
  // containing the setting text must not flip the mode for later statements,
  // or a following backslash literal is scanned as escaped and merges text.
  const q = "SELECT 'standard_conforming_strings=off'; SELECT 'c:\\;';"
  assert.equal(
    formatSql(q),
    "SELECT\n\t'standard_conforming_strings=off';\n\n\nSELECT\n\t'c:\\;';",
  )
})
