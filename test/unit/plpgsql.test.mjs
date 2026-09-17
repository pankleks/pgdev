import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceLoader } from '../lib/load.mjs'

const load = sourceLoader()
const { bodySymbols, parseRoutineHeader, parseDeclareVariables, enclosingRoutineBody } =
  await load('web/monaco/plpgsql.ts')

const FUNCTION_SQL = `CREATE OR REPLACE FUNCTION public.calc(
  IN a integer,
  OUT b text,
  INOUT c numeric
) RETURNS record LANGUAGE plpgsql AS $func$
DECLARE
  total numeric := 0;
  name text;
BEGIN
  RETURN;
END
$func$ LANGUAGE plpgsql;`

test('the routine header yields parameters with modes', () => {
  const header = parseRoutineHeader(FUNCTION_SQL.slice(0, FUNCTION_SQL.indexOf('$func$')))
  assert.equal(header.kind, 'function')
  assert.deepEqual(header.chain, ['public', 'calc'])
  assert.deepEqual(
    header.params.map((p) => ({ name: p.name, type: p.type, mode: p.mode })),
    [
      { name: 'a', type: 'integer', mode: 'in' },
      { name: 'b', type: 'text', mode: 'out' },
      { name: 'c', type: 'numeric', mode: 'inout' },
    ],
  )
})

test('RETURNS TABLE is not mistaken for the parameter list', () => {
  const before = 'CREATE FUNCTION f(a integer) RETURNS TABLE(x integer, y integer) LANGUAGE plpgsql AS '
  const header = parseRoutineHeader(before)
  assert.equal(header.params.length, 1)
  assert.equal(header.params[0].name, 'a')
})

test('DECLARE variables are read up to BEGIN', () => {
  const body = enclosingRoutineBody(FUNCTION_SQL, FUNCTION_SQL.indexOf('RETURN;'))
  const vars = parseDeclareVariables(body.inner)
  assert.deepEqual(vars, [
    { name: 'total', type: 'numeric' },
    { name: 'name', type: 'text' },
  ])
})

test('body symbols combine parameters and variables inside the body', () => {
  const symbols = bodySymbols(FUNCTION_SQL, FUNCTION_SQL.indexOf('RETURN;') + 3)
  assert.deepEqual(
    symbols.map((s) => ({ name: s.name, kind: s.kind, mode: s.mode })),
    [
      { name: 'a', kind: 'param', mode: 'in' },
      { name: 'b', kind: 'param', mode: 'out' },
      { name: 'c', kind: 'param', mode: 'inout' },
      { name: 'total', kind: 'variable', mode: 'in' },
      { name: 'name', kind: 'variable', mode: 'in' },
    ],
  )
})

test('body symbols appear only inside the body', () => {
  assert.deepEqual(bodySymbols(FUNCTION_SQL, FUNCTION_SQL.indexOf('CREATE') + 3), [])
  assert.deepEqual(bodySymbols(FUNCTION_SQL, FUNCTION_SQL.length + 5), [])
})

test('a DO block offers its DECLARE variables without parameters', () => {
  const sql = 'DO $$ DECLARE n integer; BEGIN PERFORM n; END $$;'
  const symbols = bodySymbols(sql, sql.indexOf('PERFORM'))
  assert.deepEqual(symbols.map((s) => ({ name: s.name, kind: s.kind })), [{ name: 'n', kind: 'variable' }])
})

test('a SQL-language body still offers header parameters', () => {
  const sql = 'CREATE FUNCTION f(mult integer) RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;'
  const symbols = bodySymbols(sql, sql.indexOf('SELECT'))
  assert.deepEqual(symbols.map((s) => ({ name: s.name, kind: s.kind })), [{ name: 'mult', kind: 'param' }])
})
