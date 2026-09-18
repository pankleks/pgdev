import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceLoader } from '../lib/load.mjs'

const load = sourceLoader()
const { modelUri } = await load('web/lib/modeluri.ts')

// Every editor tab gets one Monaco model keyed by its tab key. The key is
// built from user data (schema and object names, oids), so the derivation
// must be injective: two distinct keys must never land on one model URI,
// or the second createModel throws and the tab cannot open.

test('the model URI wraps the key as an inmemory sql resource', () => {
  assert.equal(modelUri('query-1'), 'inmemory://pgdev/query-1.sql')
})

test('keys that a lossy sanitizer would merge stay distinct', () => {
  // "a.b" and a_b both folded to a_b under the old sanitizer, and table
  // names are user data.
  const pairs = [
    ['ddl-index-public-x--a.b--conn', 'ddl-index-public-x--a_b--conn'],
    ['tab/next', 'tab_next'],
  ]
  for (const [a, b] of pairs) {
    assert.notEqual(modelUri(a), modelUri(b), `${a} vs ${b}`)
  }
})
