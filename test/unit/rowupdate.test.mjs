import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceLoader } from '../lib/load.mjs'

const load = sourceLoader()
const { planRowUpdate } = await load('server/rowupdate.ts')

// The planner is the last line of defence between the row dialog and the
// database: it must only ever emit one UPDATE whose key is the exact primary
// key and whose SET list touches writable columns.

const info = {
  oid: '1',
  schema: 'public',
  name: 'items',
  columns: [
    { name: 'id', type: 'integer', generated: false, pk: true },
    { name: 'label', type: 'text', generated: false, pk: false },
    { name: 'qty', type: 'numeric', generated: false, pk: false },
    { name: 'total', type: 'numeric', generated: true, pk: false },
    { name: 'blob', type: 'bytea', generated: false, pk: false },
  ],
  pk: ['id'],
}

test('builds one parameterized UPDATE with RETURNING *', () => {
  assert.deepEqual(planRowUpdate({ key: { id: 5 }, set: { label: 'x' } }, info), {
    kind: 'ok',
    text: 'UPDATE "public"."items" SET "label" = $1 WHERE "id" = $2 RETURNING *',
    values: ['x', 5],
  })
})

test('set columns stay in payload order and NULL means SQL NULL', () => {
  assert.deepEqual(
    planRowUpdate({ key: { id: 5 }, set: { label: null, qty: '1.50' } }, info),
    {
      kind: 'ok',
      text: 'UPDATE "public"."items" SET "label" = $1, "qty" = $2 WHERE "id" = $3 RETURNING *',
      values: [null, '1.50', 5],
    },
  )
})

test('a composite key keeps catalog key order, not payload order', () => {
  const composite = {
    ...info,
    columns: [
      { name: 'a', type: 'integer', generated: false, pk: true },
      { name: 'b', type: 'integer', generated: false, pk: true },
      { name: 'v', type: 'text', generated: false, pk: false },
    ],
    pk: ['a', 'b'],
  }
  assert.deepEqual(planRowUpdate({ key: { b: 2, a: 1 }, set: { v: 'x' } }, composite), {
    kind: 'ok',
    text: 'UPDATE "public"."items" SET "v" = $1 WHERE "a" = $2 AND "b" = $3 RETURNING *',
    values: ['x', 1, 2],
  })
})

test('the key must be exactly the primary key', () => {
  assert.deepEqual(planRowUpdate({ key: { label: 'x' }, set: { label: 'y' } }, info), {
    kind: 'error',
    error: { kind: 'key-mismatch', expected: ['id'] },
  })
  assert.deepEqual(planRowUpdate({ key: { id: 5, label: 'x' }, set: { label: 'y' } }, info), {
    kind: 'error',
    error: { kind: 'key-mismatch', expected: ['id'] },
  })
})

test('a missing or NULL key value is rejected', () => {
  assert.deepEqual(planRowUpdate({ key: { id: null }, set: { label: 'x' } }, info), {
    kind: 'error',
    error: { kind: 'no-key', column: 'id' },
  })
  assert.deepEqual(planRowUpdate({ key: { id: { nested: 1 } }, set: { label: 'x' } }, info), {
    kind: 'error',
    error: { kind: 'no-key', column: 'id' },
  })
})

test('empty, unknown, locked and malformed fields are rejected', () => {
  assert.deepEqual(planRowUpdate({ key: { id: 5 }, set: {} }, info), {
    kind: 'error',
    error: { kind: 'no-values' },
  })
  assert.deepEqual(planRowUpdate({ key: { id: 5 }, set: { nope: 'x' } }, info), {
    kind: 'error',
    error: { kind: 'unknown-column', column: 'nope' },
  })
  assert.deepEqual(planRowUpdate({ key: { id: 5 }, set: { id: 6 } }, info), {
    kind: 'error',
    error: { kind: 'locked-column', column: 'id' },
  })
  assert.deepEqual(planRowUpdate({ key: { id: 5 }, set: { total: '9' } }, info), {
    kind: 'error',
    error: { kind: 'locked-column', column: 'total' },
  })
  assert.deepEqual(planRowUpdate({ key: { id: 5 }, set: { blob: 'x' } }, info), {
    kind: 'error',
    error: { kind: 'locked-column', column: 'blob' },
  })
  assert.deepEqual(planRowUpdate({ key: { id: 5 }, set: { label: { a: 1 } } }, info), {
    kind: 'error',
    error: { kind: 'bad-value', column: 'label' },
  })
})
