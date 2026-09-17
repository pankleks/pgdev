import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceLoader } from '../lib/load.mjs'

const load = sourceLoader()
const { identifierAt, identifierRangeAt, callSite } = await load('web/monaco/sqlcontext.ts')

// Hover and completion share this scanner: the identifier under the cursor,
// its dotted chain, and whether a call parenthesis follows. Cursors inside
// strings, comments and dollar bodies must find nothing.

test('identifiers resolve with their dotted chain', () => {
  const plain = identifierAt('select translation from t', 10)
  assert.deepEqual(plain, {
    name: 'translation',
    raw: 'translation',
    start: 7,
    end: 18,
    chain: ['translation'],
    quoted: false,
  })
  assert.deepEqual(identifierAt('select d.translation from t', 12)?.chain, ['d', 'translation'])
  assert.deepEqual(identifierAt('select app.calc(1)', 13)?.chain, ['app', 'calc'])
  assert.deepEqual(identifierAt('select a.b.c from t', 10)?.chain, ['a', 'b', 'c'])
})

test('quoted identifiers keep their spelling', () => {
  const quoted = identifierAt('select "My Col" from t', 10)
  assert.equal(quoted?.name, 'My Col')
  assert.equal(quoted?.raw, '"My Col"')
  assert.equal(quoted?.quoted, true)
})

test('the cursor may sit at either end of the word', () => {
  const text = 'select count from t'
  assert.equal(identifierAt(text, 7)?.name, 'count')
  assert.equal(identifierAt(text, 12)?.name, 'count')
  // A punctuation offset belongs to no identifier.
  assert.equal(identifierAt('select count + 3', 13), null)
})

test('strings, comments and dollar bodies hide identifiers', () => {
  assert.equal(identifierAt("select 'translation' from t", 10), null)
  assert.equal(identifierAt('select 1 -- translation', 12), null)
  assert.equal(identifierAt('select 1 /* translation */', 12), null)
  assert.equal(identifierAt('select $$ translation $$', 10), null)
})

test('identifierRangeAt covers the whole identifier being replaced', () => {
  const text = 'select ite from t'
  assert.deepEqual(identifierRangeAt(text, 10), { start: 7, end: 10 })
  // A fully typed unquoted identifier is replaced entirely.
  assert.deepEqual(identifierRangeAt('select items', 12), { start: 7, end: 12 })
  // Quoted identifiers include their quotes.
  const quoted = 'select "My Co" from t'
  assert.deepEqual(identifierRangeAt(quoted, 14), { start: 7, end: 14 })
  // An unterminated quote is still replaced as one identifier.
  assert.deepEqual(identifierRangeAt('select "My Co', 13), { start: 7, end: 13 })
})

test('identifierRangeAt is empty before an identifier, after a dot and on punctuation', () => {
  // Cursor just before FROM has not typed an identifier yet.
  assert.equal(identifierRangeAt('SELECT FROM t', 7), null)
  assert.equal(identifierRangeAt('select app.', 11), null)
  assert.equal(identifierRangeAt('select a + b', 10), null)
})

test('identifierRangeAt looks inside dollar-quoted routine bodies', () => {
  const body = 'CREATE FUNCTION f() RETURNS void AS $$ BEGIN local_su END $$;'
  const inner = body.indexOf('local_su') + 'local_su'.length
  assert.deepEqual(identifierRangeAt(body, inner), {
    start: body.indexOf('local_su'),
    end: inner,
  })
})

test('call sites are detected across spacing and comments', () => {
  assert.equal(callSite('select translation(', 18), true)
  assert.equal(callSite('select translation (', 18), true)
  assert.equal(callSite('select translation\n(', 18), true)
  assert.equal(callSite('select translation /* c */ (', 18), true)
  assert.equal(callSite('select translation from t', 18), false)
  assert.equal(callSite('select translation::text', 18), false)
  assert.equal(callSite('select translation', 18), false)
})
