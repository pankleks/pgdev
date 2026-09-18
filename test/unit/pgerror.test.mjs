import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceLoader } from '../lib/load.mjs'

const { pgErrorMessage } = await sourceLoader()('server/pgerror.ts')

// Every server error reaches the UI as {"error": text}: an empty message
// used to arrive as {"error":""} with nothing to show.

test('a populated message passes through trimmed', () => {
  assert.equal(pgErrorMessage({ message: '  boom  ' }), 'boom')
})

test('an empty message falls back to detail, then code', () => {
  assert.equal(pgErrorMessage({ message: ' ', detail: 'is down', code: '08006' }), 'is down (code 08006)')
  assert.equal(pgErrorMessage({ message: '', code: 'ECONNREFUSED' }), 'Connection failed (code ECONNREFUSED)')
})

test('non-objects stringify, objects without text use the fallback', () => {
  assert.equal(pgErrorMessage(new Error('x')), 'x')
  assert.equal(pgErrorMessage('plain failure'), 'plain failure')
  assert.equal(pgErrorMessage({}), 'Connection failed')
  assert.equal(pgErrorMessage(null), 'Connection failed')
  assert.equal(pgErrorMessage(null, 'custom'), 'custom')
})
