import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceLoader } from '../lib/load.mjs'

const load = sourceLoader()
const { typeLength } = await load('server/typelength.ts')

// The row editor turns a declared character length into a maxlength on the
// text control. atttypmod carries VARHDRSZ (4) for varchar/char; reading the
// modifier as a length for any other type would silently cap the value.

test('character types expose their declared length', () => {
  assert.equal(typeLength('character varying', 24), 20)
  assert.equal(typeLength('character varying', 5), 1)
  assert.equal(typeLength('character', 12), 8)
})

test('unbounded and modifierless types have no length', () => {
  assert.equal(typeLength('character varying', -1), null)
  assert.equal(typeLength('character', -1), null)
  assert.equal(typeLength('text', -1), null)
  assert.equal(typeLength('integer', -1), null)
})

test('other types\' modifiers are not character lengths', () => {
  assert.equal(typeLength('numeric', 327686), null)
  assert.equal(typeLength('timestamp without time zone', 3), null)
})
