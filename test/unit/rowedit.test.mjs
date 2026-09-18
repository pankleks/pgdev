import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceLoader } from '../lib/load.mjs'

const { editableGrid } = await sourceLoader()('server/catalog/rowedit.ts')

// The editable gate: a wrong "editable" answer makes the UI offer row edits
// whose WHERE clause cannot identify the row. Every PK column must appear
// exactly once in the result.

const info = (pk, names) => ({
  oid: '1',
  schema: 'public',
  name: 'items',
  columns: names.map((name) => ({
    name, type: 'integer', generated: false, pk: pk.includes(name), nullable: true,
  })),
  pk,
})

test('tables without a primary key are never editable', () => {
  assert.equal(editableGrid(info([], ['id']), ['id'], null), null)
})

test('a missing or duplicated PK column refuses editing', () => {
  const i = info(['id'], ['id', 'label'])
  assert.equal(editableGrid(i, ['label'], null), null, 'PK absent from the select list')
  assert.equal(editableGrid(i, ['id', 'id'], null), null, 'PK selected twice')
  assert.equal(editableGrid(info(['a', 'b'], ['a', 'b']), ['a'], null), null, 'composite key half present')
})

test('an aliased PK column is not the PK column', () => {
  // SELECT id AS item_id: the result carries item_id, so id counts as missing.
  assert.equal(editableGrid(info(['id'], ['id']), ['item_id'], null), null)
})

test('a plain PK-complete select is editable with its columns', () => {
  const grid = editableGrid(info(['id'], ['id', 'label']), ['id', 'label'], null)
  assert.deepEqual(grid.pk, ['id'])
  assert.equal(grid.schema, 'public')
  assert.equal(grid.table, 'items')
  assert.deepEqual(grid.columns.map((c) => c.name), ['id', 'label'])
})

test('expression and duplicate columns are excluded but the grid stays editable', () => {
  // `allowed` is the statement's plain column references (null means `*`):
  // computed selections never become editable cells, and a column selected
  // twice cannot identify a single cell either.
  const grid = editableGrid(info(['id'], ['id', 'label']), ['id', 'label', 'label', 'total'], ['id', 'label'])
  assert.deepEqual(grid.columns.map((c) => c.name), ['id'])
  const star = editableGrid(info(['id'], ['id', 'label']), ['id', 'label'], null)
  assert.deepEqual(star.columns.map((c) => c.name), ['id', 'label'])
})
