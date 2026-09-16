import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceLoader } from '../lib/load.mjs'

const load = sourceLoader()
const { sequenceOptions } = await load('server/catalog/ddl.ts')

// The formatter turns pg_sequence's stored values into the options that make
// a rebuilt sequence identical. Serial and identity always create ascending
// sequences, so a bare creation's defaults are the baseline.
const BIG = { type: 'bigint', start: '1', increment: '1', min: '1', max: '9223372036854775807', cache: '1', cycle: false }
const withOverrides = (overrides) => ({ ...BIG, ...overrides })

test('a fully default sequence emits nothing', () => {
  assert.deepEqual(sequenceOptions(BIG, null), [])
})

test('ascending nondefaults emit in pg_dump order', () => {
  assert.deepEqual(
    sequenceOptions(withOverrides({
      start: '100', increment: '10', min: '50', max: '1000', cache: '5', cycle: true,
    }), 'SEQUENCE NAME "public"."moved"'),
    ['SEQUENCE NAME "public"."moved"', 'MINVALUE 50', 'MAXVALUE 1000', 'START WITH 100', 'INCREMENT BY 10', 'CACHE 5', 'CYCLE'],
  )
})

test('a start-only sequence keeps its default bounds', () => {
  // START WITH 100 without MINVALUE: min stays 1, max stays the type maximum,
  // and start no longer equals min — the only thing to emit.
  assert.deepEqual(sequenceOptions(withOverrides({ start: '100' }), null), ['START WITH 100'])
})

test('smallint bounds are the type range, not bigint', () => {
  assert.deepEqual(
    sequenceOptions(withOverrides({ type: 'smallint', start: '5', min: '5', max: '300' }), null),
    ['MINVALUE 5', 'MAXVALUE 300'],
  )
  assert.deepEqual(
    sequenceOptions(withOverrides({ type: 'integer', max: '2147483647' }), null),
    [],
  )
})

test('descending sequences emit against their own defaults', () => {
  // Bare descending: min = type minimum, max = -1, start = MAXVALUE. Only the
  // increment itself is nondefault — rebuilt sequences start ascending, so
  // INCREMENT BY -1 is what makes the rebuild descending at all.
  assert.deepEqual(
    sequenceOptions(withOverrides({ start: '-1', increment: '-1', min: '-9223372036854775808', max: '-1' }), null),
    ['INCREMENT BY -1'],
  )
  // INCREMENT BY -1 itself is nondefault: rebuilt sequences start ascending.
  assert.deepEqual(
    sequenceOptions(withOverrides({ start: '50', increment: '-1', min: '1', max: '50' }), null),
    ['MINVALUE 1', 'MAXVALUE 50', 'INCREMENT BY -1'],
  )
  assert.deepEqual(
    sequenceOptions(withOverrides({ start: '20', increment: '-2', min: '1', max: '50' }), null),
    ['MINVALUE 1', 'MAXVALUE 50', 'START WITH 20', 'INCREMENT BY -2'],
  )
})

test('a non-integer sequence type emits nothing rather than wrong DDL', () => {
  assert.deepEqual(sequenceOptions(withOverrides({ type: 'numeric' }), null), [])
})
