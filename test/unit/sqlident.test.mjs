import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceLoader } from '../lib/load.mjs'

const { ident } = await sourceLoader()('server/sqlident.ts')

// The only interpolation helper for catalog names: an unescaped quote would
// break out of the identifier and change the statement.

test('quotes plain names and doubles embedded quotes', () => {
  assert.equal(ident('items'), '"items"')
  assert.equal(ident('weird"name'), '"weird""name"')
  assert.equal(ident('a"b"c'), '"a""b""c"')
  assert.equal(ident(''), '""')
})
