import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceLoader } from '../lib/load.mjs'

const load = sourceLoader()
const { parseColumnType, buildColumnType } = await load('web/lib/tabletype.ts')

test('parseColumnType folds catalog spellings onto the drop-down base', () => {
  assert.deepEqual(parseColumnType('character varying(50)'), { base: 'varchar', len: '50', scale: '' })
  assert.deepEqual(parseColumnType('varchar(50)'), { base: 'varchar', len: '50', scale: '' })
  assert.deepEqual(parseColumnType('numeric(10,2)'), { base: 'numeric', len: '10', scale: '2' })
  // PostgreSQL always renders a numeric scale, even zero.
  assert.deepEqual(parseColumnType('numeric(10,0)'), { base: 'numeric', len: '10', scale: '0' })
  assert.deepEqual(parseColumnType('numeric'), { base: 'numeric', len: '', scale: '' })
  assert.deepEqual(parseColumnType('character(4)'), { base: 'char', len: '4', scale: '' })
  assert.deepEqual(parseColumnType('decimal(8,3)'), { base: 'numeric', len: '8', scale: '3' })
  assert.deepEqual(parseColumnType('integer'), { base: 'integer', len: '', scale: '' })
  assert.deepEqual(parseColumnType('timestamp without time zone'), {
    base: 'timestamp without time zone', len: '', scale: '',
  })
})

test('buildColumnType accepts the number a type="number" input produces', () => {
  // v-model on type="number" hands the model a number; calling .trim() on it
  // used to throw and leave the type unchanged, so the change was lost.
  assert.equal(buildColumnType('varchar', 100, ''), 'varchar(100)')
  assert.equal(buildColumnType('numeric', 10, 2), 'numeric(10,2)')
  assert.equal(buildColumnType('char', 8, ''), 'char(8)')
  // The scale field is the same kind of input.
  assert.equal(buildColumnType('numeric', 12, 0), 'numeric(12,0)')
  assert.equal(buildColumnType('numeric', 12, 4), 'numeric(12,4)')
})

test('buildColumnType keeps unedited and unsized bases intact', () => {
  assert.equal(buildColumnType('char', '', ''), 'char')
  assert.equal(buildColumnType('varchar', '   ', ''), 'varchar')
  assert.equal(buildColumnType('integer', 5, 2), 'integer')
  // A cleared scale still emits PostgreSQL's canonical (precision,scale) form.
  assert.equal(buildColumnType('numeric', 10, ''), 'numeric(10,0)')
  // Scale without precision is not a valid numeric type; keep the base.
  assert.equal(buildColumnType('numeric', '', 2), 'numeric')
})
