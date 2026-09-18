import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceLoader } from '../lib/load.mjs'

const { rawTextTypes } = await sourceLoader()('server/pgtypes.ts')

// JSON/temporal/array columns must reach the browser as raw server text:
// the driver's parsers lose bigint precision, rewrite number spellings and
// turn dates into shifted ISO strings.

test('lossy type ids parse as identity', () => {
  for (const oid of [114, 3802, 1082, 1083, 1114, 1184, 1266, 1182, 1183, 1115, 1185, 1270,
    1000, 1005, 1007, 1016, 1009, 1014, 1015]) {
    const parse = rawTextTypes.getTypeParser(oid)
    assert.equal(parse('{"id":9007199254740993}'), '{"id":9007199254740993}', `oid ${oid}`)
  }
})

test('ordinary types keep the driver parser', () => {
  const parse = rawTextTypes.getTypeParser(23)
  assert.equal(typeof parse, 'function')
  assert.equal(parse('42'), 42)
})
