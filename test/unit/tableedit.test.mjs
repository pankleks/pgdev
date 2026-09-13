import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceLoader } from '../lib/load.mjs'

const load = sourceLoader()
const { diffTableEdit, isNewColumnId } = await load('server/catalog/tableedit.ts')

// The diff decides which ALTER statements the table editor emits, so every
// rule here is behaviour: an unnecessary statement is a bug, and so is a
// rejected edit the server should have accepted.

const col = (name, extra = {}) => ({
  name,
  type: 'integer',
  nullable: true,
  defaultValue: null,
  description: null,
  pk: false,
  unique: false,
  locked: false,
  lockKind: undefined,
  ...extra,
})

const live = (columns, extra = {}) => ({
  relkind: 'r',
  schema: 'public',
  name: 't',
  description: null,
  columns,
  ...extra,
})

const edit = (name, extra = {}) => ({
  id: extra.id ?? name,
  name,
  type: 'integer',
  nullable: true,
  defaultValue: null,
  description: null,
  ...extra,
})

function runOut(l, request) {
  return diffTableEdit(l, request)
}

function errKind(outcome) {
  assert.equal(outcome.kind, 'error', `expected error, got ${JSON.stringify(outcome)}`)
  return outcome.error.kind
}

test('isNewColumnId accepts only the new:<n> shape', () => {
  assert.equal(isNewColumnId('new:1'), true)
  assert.equal(isNewColumnId('new:42'), true)
  assert.equal(isNewColumnId('a'), false)
  assert.equal(isNewColumnId('new:x'), false)
  assert.equal(isNewColumnId('new:'), false)
})

test('identical request produces no statements', () => {
  const l = live([col('a'), col('b', { defaultValue: 'now()' })])
  const out = runOut(l, {
    description: null,
    columns: [edit('a'), edit('b', { defaultValue: 'now()' })],
  })
  assert.deepEqual(out, { kind: 'ok', statements: [] })
})

test('type change emits ALTER COLUMN TYPE with the requested type', () => {
  const l = live([col('a')])
  const out = runOut(l, { description: null, columns: [edit('a', { type: 'varchar(50)' })] })
  assert.deepEqual(out.statements, ['ALTER TABLE "public"."t"\n  ALTER COLUMN "a" TYPE varchar(50)'])
})

test('nullable flips in both directions', () => {
  const l = live([col('a', { nullable: true }), col('b', { nullable: false })])
  const out = runOut(l, {
    description: null,
    columns: [edit('a', { nullable: false }), edit('b', { nullable: true })],
  })
  assert.deepEqual(out.statements, [
    'ALTER TABLE "public"."t"\n  ALTER COLUMN "a" SET NOT NULL',
    'ALTER TABLE "public"."t"\n  ALTER COLUMN "b" DROP NOT NULL',
  ])
})

test('default set, clear and whitespace-only differences', () => {
  const l = live([col('a'), col('b', { defaultValue: "now( )" }), col('c', { defaultValue: 'x' })])
  const out = runOut(l, {
    description: null,
    columns: [
      edit('a', { defaultValue: "'lit'" }),
      // same expression modulo whitespace: no statement
      edit('b', { defaultValue: 'now(  )' }),
      // cleared default: DROP
      edit('c', { defaultValue: '' }),
    ],
  })
  assert.deepEqual(out.statements, [
    'ALTER TABLE "public"."t"\n  ALTER COLUMN "a" SET DEFAULT \'lit\'',
    'ALTER TABLE "public"."t"\n  ALTER COLUMN "c" DROP DEFAULT',
  ])
})

test('rename is emitted before later clauses use the new name', () => {
  const l = live([col('a')])
  const out = runOut(l, {
    description: null,
    columns: [edit('b', { id: 'a', type: 'text', nullable: false })],
  })
  assert.deepEqual(out.statements, [
    'ALTER TABLE "public"."t"\n  RENAME COLUMN "a" TO "b"',
    'ALTER TABLE "public"."t"\n  ALTER COLUMN "b" TYPE text',
    'ALTER TABLE "public"."t"\n  ALTER COLUMN "b" SET NOT NULL',
  ])
})

test('column and table comments are emitted only when they change', () => {
  const l = live([col('a', { description: 'old' })], { description: 'table old' })
  const out = runOut(l, {
    description: 'table new',
    columns: [edit('a', { description: 'new' }), edit('z', { id: 'new:1', name: 'b', type: 'text', description: 'added note' })],
  })
  assert.deepEqual(out.statements, [
    'ALTER TABLE "public"."t"\n  ADD COLUMN "b" text',
    `COMMENT ON COLUMN "public"."t"."a" IS 'new'`,
    `COMMENT ON COLUMN "public"."t"."b" IS 'added note'`,
    `COMMENT ON TABLE "public"."t" IS 'table new'`,
  ])
})

test('cleared comments become COMMENT ... IS NULL', () => {
  const l = live([col('a', { description: 'x' })], { description: 'y' })
  const out = runOut(l, {
    description: '   ',
    columns: [edit('a', { description: '' })],
  })
  assert.deepEqual(out.statements, [
    'COMMENT ON COLUMN "public"."t"."a" IS NULL',
    'COMMENT ON TABLE "public"."t" IS NULL',
  ])
})

test('quotes in comment text are escaped, not interpreted', () => {
  const l = live([col('a')])
  const out = runOut(l, {
    description: null,
    columns: [edit('a', { description: "it's a 'test'" })],
  })
  assert.deepEqual(out.statements, ['COMMENT ON COLUMN "public"."t"."a" IS \'it\'\'s a \'\'test\'\'\''])
})

test('added columns carry default before not null and validation', () => {
  const l = live([])
  const out = runOut(l, {
    description: null,
    columns: [edit('flag', { id: 'new:1', type: 'boolean', nullable: false, defaultValue: 'false' })],
  })
  assert.deepEqual(out.statements, ['ALTER TABLE "public"."t"\n  ADD COLUMN "flag" boolean DEFAULT false NOT NULL'])
})

test('dropped column emits DROP COLUMN and loses its comment', () => {
  const l = live([col('a', { description: 'keep?' }), col('gone', { description: 'note' })])
  const out = runOut(l, {
    description: null,
    columns: [edit('a', { description: 'keep?' })],
  })
  assert.deepEqual(out.statements, ['ALTER TABLE "public"."t"\n  DROP COLUMN "gone"'])
})

test('drops come before renames, so a rename may reuse a dropped name', () => {
  const l = live([col('a'), col('b')])
  const out = runOut(l, {
    description: null,
    columns: [edit('b', { id: 'a' })],
  })
  // a is renamed to b, and b itself is dropped — with drops first the rename
  // finds its target name free.
  assert.deepEqual(out.statements, [
    'ALTER TABLE "public"."t"\n  DROP COLUMN "b"',
    'ALTER TABLE "public"."t"\n  RENAME COLUMN "a" TO "b"',
  ])
})

test('deleting a primary-key column is rejected', () => {
  const l = live([col('a', { pk: true, nullable: false }), col('b')])
  // The request omits "a" entirely — that is what a delete looks like.
  const out = runOut(l, { description: null, columns: [edit('b')] })
  assert.equal(errKind(out), 'pk-drop')
})

test('making a primary-key column nullable is rejected', () => {
  const l = live([col('a', { pk: true, nullable: false })])
  const out = runOut(l, { description: null, columns: [edit('a', { nullable: true })] })
  assert.equal(errKind(out), 'pk-nullable')
})

test('editing a locked column rejects type, default and nullable changes', () => {
  const base = col('s', { type: 'integer', defaultValue: "nextval('s_seq'::regclass)", nullable: false, locked: true, lockKind: 'serial' })
  assert.equal(
    errKind(runOut(live([base]), { description: null, columns: [edit('s', { type: 'bigint' })] })),
    'locked',
  )
  assert.equal(
    errKind(runOut(live([base]), { description: null, columns: [edit('s', { defaultValue: '7' })] })),
    'locked',
  )
  assert.equal(
    errKind(runOut(live([base]), { description: null, columns: [edit('s', { nullable: true })] })),
    'locked',
  )
})

test('a serial column may change nullability, but identity may not', () => {
  const seqDefault = "nextval('t_s_seq'::regclass)"
  const serial = col('s', { nullable: true, locked: true, lockKind: 'serial', defaultValue: seqDefault })
  // The editor shows the serial default read-only, so the request echoes it.
  const out = runOut(live([serial]), {
    description: null,
    columns: [edit('s', { nullable: false, defaultValue: seqDefault })],
  })
  assert.deepEqual(out.statements, ['ALTER TABLE "public"."t"\n  ALTER COLUMN "s" SET NOT NULL'])

  const identity = col('i', { nullable: true, locked: true, lockKind: 'identity' })
  const out2 = runOut(live([identity]), { description: null, columns: [edit('i', { nullable: false })] })
  assert.equal(errKind(out2), 'locked')
})

test('locked columns still allow renames and description edits', () => {
  const l = live([col('s', { locked: true, lockKind: 'identity', description: 'note' })])
  const out = runOut(l, {
    description: null,
    columns: [edit('renamed', { id: 's', description: 'note2' })],
  })
  assert.deepEqual(out.statements, [
    'ALTER TABLE "public"."t"\n  RENAME COLUMN "s" TO "renamed"',
    'COMMENT ON COLUMN "public"."t"."renamed" IS \'note2\'',
  ])
})

test('renaming onto another existing column is rejected as a duplicate', () => {
  const l = live([col('a'), col('b')])
  const out = runOut(l, { description: null, columns: [edit('b', { id: 'a' }), edit('b')] })
  assert.equal(errKind(out), 'duplicate')
})

test('a request id that matches no live column is rejected', () => {
  const l = live([col('a')])
  const out = runOut(l, { description: null, columns: [edit('a'), edit('zzz')] })
  assert.equal(errKind(out), 'unknown-column')
})

test('duplicate new-column names are rejected', () => {
  const l = live([])
  const out = runOut(l, {
    description: null,
    columns: [edit('x', { id: 'new:1', type: 'text' }), edit('x', { id: 'new:2', type: 'text' })],
  })
  assert.equal(errKind(out), 'duplicate')
})

test('empty names and types are rejected', () => {
  const l = live([col('a')])
  assert.equal(errKind(runOut(l, { description: null, columns: [edit('  ')] })), 'empty-name')
  assert.equal(
    errKind(runOut(live([]), { description: null, columns: [edit('x', { id: 'new:1', type: '   ' })] })),
    'empty-type',
  )
  assert.equal(
    errKind(runOut(l, { description: null, columns: [edit('a', { type: '' })] })),
    'empty-type',
  )
})
