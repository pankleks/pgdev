import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceLoader } from '../lib/load.mjs'

const load = sourceLoader()
const { splitStatements } = await load('server/sqlsplit.ts')

// The splitter decides what runs as a separate statement, so a mistake here
// changes query semantics rather than presentation.
test('splits on top-level semicolons only', () => {
  assert.deepEqual(splitStatements('SELECT 1; SELECT 2;'), ['SELECT 1', 'SELECT 2'])
  assert.deepEqual(splitStatements('SELECT 1'), ['SELECT 1'])
  assert.deepEqual(splitStatements(';; SELECT 1 ;;'), ['SELECT 1'])
})

test('ignores semicolons inside string literals', () => {
  assert.deepEqual(splitStatements("SELECT ';';"), ["SELECT ';'"])
  assert.deepEqual(splitStatements("SELECT 'it''s; ok';"), ["SELECT 'it''s; ok'"])
})

test('honours E-string backslash escapes regardless of the setting', () => {
  assert.deepEqual(splitStatements("SELECT E'a\\';b';"), ["SELECT E'a\\';b'"])
})

test('ignores semicolons inside quoted identifiers', () => {
  assert.deepEqual(splitStatements('SELECT 1 AS "a;b";'), ['SELECT 1 AS "a;b"'])
  assert.deepEqual(splitStatements('SELECT 1 AS "a""b;c";'), ['SELECT 1 AS "a""b;c"'])
})

test('ignores semicolons in line and block comments, including nested', () => {
  assert.deepEqual(splitStatements('SELECT 1 -- ;\n; SELECT 2'), ['SELECT 1 -- ;', 'SELECT 2'])
  assert.deepEqual(splitStatements('SELECT /* ; */ 1;'), ['SELECT /* ; */ 1'])
  assert.deepEqual(splitStatements('SELECT /* a /* b ; */ c */ 1;'), ['SELECT /* a /* b ; */ c */ 1'])
})

test('keeps dollar-quoted bodies intact', () => {
  assert.deepEqual(
    splitStatements('CREATE FUNCTION f() RETURNS int AS $$ SELECT 1; $$ LANGUAGE sql;'),
    ['CREATE FUNCTION f() RETURNS int AS $$ SELECT 1; $$ LANGUAGE sql'],
  )
  assert.deepEqual(splitStatements('DO $body$ BEGIN; END $body$;'), ['DO $body$ BEGIN; END $body$'])
})

test('tracks standard_conforming_strings across statements', () => {
  // on (the default): a backslash is literal, so the quote closes the string
  assert.deepEqual(
    splitStatements("SET standard_conforming_strings = on; SELECT 'a\\';"),
    ['SET standard_conforming_strings = on', "SELECT 'a\\'"],
  )
  // off: the backslash escapes the quote, so the statement continues
  assert.deepEqual(
    splitStatements("SET standard_conforming_strings = off; SELECT 'a\\';b';"),
    ['SET standard_conforming_strings = off', "SELECT 'a\\';b'"],
  )
})

test('an identifier ending in e does not turn its string into an E-string', () => {
  // SCS=on: `type='a\'` closes at that quote, so the batch splits.
  // Misreading the `e` of `type` as an E-prefix would swallow the rest.
  assert.deepEqual(
    splitStatements("SELECT type='a\\'; SELECT 2"),
    ["SELECT type='a\\'", 'SELECT 2'],
  )
  // A standalone E prefix still escapes.
  assert.deepEqual(
    splitStatements("SELECT E'a\\'; SELECT 2;'"),
    ["SELECT E'a\\'; SELECT 2;'"],
  )
})

test('U&-prefixed strings honour backslash escapes under SCS=on', () => {
  assert.deepEqual(
    splitStatements("SELECT u&'a\\'; SELECT 2;'"),
    ["SELECT u&'a\\'; SELECT 2;'"],
  )
  // The & alone must not trigger it: a plain string with a literal backslash.
  assert.deepEqual(
    splitStatements("SELECT x&'a\\'; SELECT 2"),
    ["SELECT x&'a\\'", 'SELECT 2'],
  )
})

test('returns no statements for empty or comment-only input', () => {
  assert.deepEqual(splitStatements(''), [])
  assert.deepEqual(splitStatements('   \n\t '), [])
})

test('keeps a trailing statement with no semicolon', () => {
  assert.deepEqual(splitStatements('SELECT 1;\nSELECT 2'), ['SELECT 1', 'SELECT 2'])
})
