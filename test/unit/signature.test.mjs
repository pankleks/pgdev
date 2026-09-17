import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceLoader } from '../lib/load.mjs'

const load = sourceLoader()
const { findCall, activeParameter, computeSignatureHelp } = await load('web/lib/signature.ts')

const fn = (over = {}) => ({
  schema: 'public',
  name: 'item_count',
  args: 'p integer',
  returns: 'integer',
  typeSig: 'int4',
  kind: 'function',
  oid: '1',
  arguments: 'p integer',
  comment: null,
  ...over,
})

const data = {
  tables: [],
  views: [],
  types: [],
  sequences: [],
  functions: [fn()],
  builtins: [
    fn({
      schema: 'pg_catalog',
      name: 'round',
      args: 'double precision, integer',
      arguments: undefined,
      returns: 'double precision',
    }),
  ],
}

test('the call under the cursor is found with its callee chain', () => {
  const simple = 'select item_count('
  assert.deepEqual(findCall(simple, simple.length), { open: simple.indexOf('('), chain: ['item_count'] })
  const qualified = 'select app.calc('
  assert.deepEqual(findCall(qualified, qualified.length), {
    open: qualified.indexOf('('),
    chain: ['app', 'calc'],
  })
  assert.equal(findCall('select item_count from t', 20), null)
})

test('grouping parentheses do not hide the enclosing call', () => {
  const text = 'select item_count((1 + 2)'
  assert.deepEqual(findCall(text, text.length)?.chain, ['item_count'])
})

test('the active parameter counts top-level commas only', () => {
  assert.equal(activeParameter('select item_count(', 17, 18), 0)
  assert.equal(activeParameter('select item_count(a, ', 17, 21), 1)
  const nested = 'select f(g(1, 2), '
  assert.equal(activeParameter(nested, nested.indexOf('('), nested.length), 1)
})

test('signature help lists the overload with the active parameter', () => {
  const text = 'select item_count('
  const help = computeSignatureHelp(data, text, text.length)
  assert.equal(help.signatures.length, 1)
  assert.equal(help.signatures[0].label, 'item_count(p integer)')
  assert.equal(help.activeSignature, 0)
  assert.equal(help.activeParameter, 0)
  const [start, end] = help.signatures[0].parameters[0].label
  assert.equal(help.signatures[0].label.slice(start, end), 'p')
})

test('a comma beyond the last parameter clamps to the last one', () => {
  const text = 'select item_count(a, '
  const help = computeSignatureHelp(data, text, text.length)
  assert.equal(help.activeParameter, 0)
})

test('multi-word types highlight the whole type, not a phantom name', () => {
  const text = 'select round('
  const help = computeSignatureHelp(data, text, text.length)
  const [start, end] = help.signatures[0].parameters[0].label
  assert.equal(help.signatures[0].label.slice(start, end), 'double precision')
})

test('outside a known call there is no signature help', () => {
  assert.equal(computeSignatureHelp(data, 'select 1', 8), null)
  assert.equal(computeSignatureHelp(data, 'select missing(', 15), null)
})

test('signature help resolves a call inside a dollar-quoted routine body', () => {
  const ddl = [
    'CREATE FUNCTION public.wrapper() RETURNS integer LANGUAGE plpgsql AS $$',
    'BEGIN',
    '  RETURN item_count(',
    'END;',
    '$$;',
  ].join('\n')
  const offset = ddl.indexOf('item_count(') + 'item_count('.length
  const help = computeSignatureHelp(data, ddl, offset)
  assert.equal(help.signatures[0].label, 'item_count(p integer)')
  assert.equal(help.activeParameter, 0)
})

test('the active parameter follows commas inside a body', () => {
  const ddl = 'DO $$ BEGIN PERFORM round(1, ); END $$;'
  const offset = ddl.indexOf('round(') + 'round(1, '.length
  const help = computeSignatureHelp(data, ddl, offset)
  assert.equal(help.signatures[0].label, 'round(double precision, integer)')
  assert.equal(help.activeParameter, 1)
})
