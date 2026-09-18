import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceLoader } from '../lib/load.mjs'

const load = sourceLoader()
const { typeLength } = await load('server/typelength.ts')

// The row editor turns a declared character length into a maxlength on the
// text control. atttypmod carries VARHDRSZ (4) for varchar/char; reading the
// modifier as a length for any other type would silently cap the value.

test('only bounded character types expose a length', () => {
  const cases = [
    ['character varying', 24, 20],
    ['character varying', 5, 1],
    ['character', 12, 8],
    ['character varying', -1, null],
    ['character', -1, null],
    ['text', -1, null],
    ['integer', -1, null],
    ['numeric', 327686, null],
    ['timestamp without time zone', 3, null],
  ]
  for (const [type, mod, want] of cases) assert.equal(typeLength(type, mod), want, `${type} ${mod}`)
})
