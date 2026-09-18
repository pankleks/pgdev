import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceLoader } from '../lib/load.mjs'

const load = sourceLoader()
const { diffTableEdit, stateFingerprint, planRenames, fkLabels, ukLabels } =
  await load('server/catalog/tableedit.ts')

// The diff decides which ALTER statements the table editor emits, so every
// rule here is behaviour: an unnecessary statement is a bug, and so is a
// rejected edit the server should have accepted.

const col = (name, extra = {}) => ({
  id: name,
  name,
  type: 'integer',
  nullable: true,
  defaultValue: null,
  description: null,
  pk: false,
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
  added: extra.added ?? false,
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

test('an existing column literally named new:1 is edited, never re-added', () => {
  // The live column's identity is its attnum; its *name* is 'new:1'.
  const l = live([col('new:1', { id: '1', type: 'text' })])
  // An unchanged echo must produce no statements — a name-pattern check would
  // have emitted a bogus ADD COLUMN here.
  assert.deepEqual(
    runOut(l, { description: null, columns: [edit('new:1', { id: '1', type: 'text' })] }),
    { kind: 'ok', statements: [] },
  )
  // And renaming it is a rename, not an add.
  const out = runOut(l, { description: null, columns: [edit('renamed', { id: '1', type: 'text' })] })
  assert.deepEqual(out.statements, ['ALTER TABLE "public"."t"\n  RENAME COLUMN "new:1" TO "renamed"'])
})

test('an added row that reuses a live column identity is rejected', () => {
  const l = live([col('a'), col('b')])
  // 'b' echoes the live b; the added row claims live a's identity.
  const out = runOut(l, {
    description: null,
    columns: [edit('b'), edit('c', { id: 'a', added: true })],
  })
  assert.equal(errKind(out), 'added-exists')
})

test('stateFingerprint is stable and reacts to any live change', () => {
  const state = {
    oid: '1',
    schema: 'public',
    name: 't',
    relkind: 'r',
    description: null,
    columns: [col('a'), col('b', { defaultValue: 'now()' })],
  }
  assert.equal(stateFingerprint(state), stateFingerprint({ ...state }))
  // Adding, altering or describing any column changes the hash, so a stale
  // dialog is always detected.
  assert.notEqual(stateFingerprint(state), stateFingerprint({ ...state, columns: [...state.columns, col('c')] }))
  assert.notEqual(stateFingerprint(state), stateFingerprint({ ...state, description: 'note' }))
  assert.notEqual(stateFingerprint(state), stateFingerprint({ ...state, columns: [col('a'), col('b', { defaultValue: 'now()', nullable: false })] }))
  // Unique keys are display-only but part of the live state: adding one
  // invalidates a stale dialog too.
  assert.notEqual(
    stateFingerprint(state),
    stateFingerprint({ ...state, columns: [col('a'), { ...col('b', { defaultValue: 'now()' }), uks: [{ label: 'UK1', name: 'bom_code_key', definition: 'UNIQUE (b)' }] }] }),
  )
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

test('whitespace inside a string literal is a real edit and is emitted verbatim', () => {
  const l = live([col('a', { defaultValue: "'North  America'" })])
  // Identical literal: not an edit, whatever the spacing around it.
  assert.deepEqual(
    runOut(l, { description: null, columns: [edit('a', { defaultValue: "'North  America'" })] }),
    { kind: 'ok', statements: [] },
  )
  const out = runOut(l, { description: null, columns: [edit('a', { defaultValue: "'North America'" })] })
  assert.deepEqual(out.statements, [
    `ALTER TABLE "public"."t"\n  ALTER COLUMN "a" SET DEFAULT 'North America'`,
  ])
})

test('emitted defaults and types keep the exact text the user typed', () => {
  const l = live([col('a', { defaultValue: 'now()', type: 'integer' })])
  const out = runOut(l, {
    description: null,
    columns: [edit('a', { defaultValue: 'now(  )', type: 'character varying( 50 )' })],
  })
  assert.deepEqual(out.statements, [
    'ALTER TABLE "public"."t"\n  ALTER COLUMN "a" TYPE character varying( 50 )',
    'ALTER TABLE "public"."t"\n  ALTER COLUMN "a" SET DEFAULT now(  )',
  ])
})

test('dollar-quoted bodies and quoted identifiers compare byte-for-byte', () => {
  const l = live([col('a', { defaultValue: '$fn$SELECT  1;$fn$' })])
  assert.deepEqual(
    runOut(l, { description: null, columns: [edit('a', { defaultValue: '$fn$SELECT  1;$fn$' })] }),
    { kind: 'ok', statements: [] },
  )
  const out = runOut(l, { description: null, columns: [edit('a', { defaultValue: '$fn$SELECT 1;$fn$' })] })
  assert.deepEqual(out.statements, [
    'ALTER TABLE "public"."t"\n  ALTER COLUMN "a" SET DEFAULT $fn$SELECT 1;$fn$',
  ])
})

test('a line comment keeps its terminating newline, so moving code out of it is an edit', () => {
  const l = live([col('a', { defaultValue: 'now() -- rest\n + 1' })])
  assert.deepEqual(
    runOut(l, { description: null, columns: [edit('a', { defaultValue: 'now() -- rest\n + 1' })] }),
    { kind: 'ok', statements: [] },
  )
  // `+ 1` is now inside the comment — same text folded, different expression.
  const out = runOut(l, { description: null, columns: [edit('a', { defaultValue: 'now() -- rest + 1' })] })
  assert.equal(out.kind, 'ok')
  assert.equal(out.statements.length, 1, JSON.stringify(out))
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
    columns: [edit('a', { description: 'new' }), edit('z', { id: 'new:1', added: true, name: 'b', type: 'text', description: 'added note' })],
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
    columns: [edit('flag', { id: 'new:1', added: true, type: 'boolean', nullable: false, defaultValue: 'false' })],
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

test('rename chains reverse so each target name is free', () => {
  const l = live([col('a'), col('b')])
  const out = runOut(l, {
    description: null,
    columns: [edit('b', { id: 'a' }), edit('c', { id: 'b' })],
  })
  // a→b must wait for b→c: emitting a→b first would collide with the live b.
  assert.deepEqual(out.statements, [
    'ALTER TABLE "public"."t"\n  RENAME COLUMN "b" TO "c"',
    'ALTER TABLE "public"."t"\n  RENAME COLUMN "a" TO "b"',
  ])
})

test('rename swaps unroll through a temporary name', () => {
  const l = live([col('a'), col('b')])
  const out = runOut(l, {
    description: null,
    columns: [edit('b', { id: 'a' }), edit('a', { id: 'b' })],
  })
  assert.deepEqual(out.statements, [
    'ALTER TABLE "public"."t"\n  RENAME COLUMN "a" TO "pgdev_rename_1"',
    'ALTER TABLE "public"."t"\n  RENAME COLUMN "b" TO "a"',
    'ALTER TABLE "public"."t"\n  RENAME COLUMN "pgdev_rename_1" TO "b"',
  ])
})

test('planRenames orders chains, unrolls cycles, and uses dropped names freely', () => {
  // Chain: c is free, so b→c first.
  assert.deepEqual(
    planRenames(
      [{ id: '1', from: 'a', to: 'b' }, { id: '2', from: 'b', to: 'c' }],
      new Set(['a', 'b']),
    ),
    [{ from: 'b', to: 'c' }, { from: 'a', to: 'b' }],
  )
  // Three-cycle a→b→c→a.
  const cycle = planRenames(
    [
      { id: '1', from: 'a', to: 'b' },
      { id: '2', from: 'b', to: 'c' },
      { id: '3', from: 'c', to: 'a' },
    ],
    new Set(['a', 'b', 'c']),
  )
  assert.deepEqual(cycle, [
    { from: 'a', to: 'pgdev_rename_1' },
    { from: 'c', to: 'a' },
    { from: 'b', to: 'c' },
    { from: 'pgdev_rename_1', to: 'b' },
  ])
  // A dropped column's name is simply not in `taken`.
  assert.deepEqual(
    planRenames([{ id: '1', from: 'a', to: 'gone' }], new Set(['a'])),
    [{ from: 'a', to: 'gone' }],
  )
})

test('renames complete before property changes on renamed columns', () => {
  const l = live([col('a'), col('b', { type: 'integer' })])
  const out = runOut(l, {
    description: null,
    columns: [
      edit('b', { id: 'a' }),
      edit('c', { id: 'b', type: 'text', nullable: false }),
    ],
  })
  assert.deepEqual(out.statements, [
    'ALTER TABLE "public"."t"\n  RENAME COLUMN "b" TO "c"',
    'ALTER TABLE "public"."t"\n  RENAME COLUMN "a" TO "b"',
    'ALTER TABLE "public"."t"\n  ALTER COLUMN "c" TYPE text',
    'ALTER TABLE "public"."t"\n  ALTER COLUMN "c" SET NOT NULL',
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
    columns: [edit('x', { id: 'new:1', added: true, type: 'text' }), edit('x', { id: 'new:2', added: true, type: 'text' })],
  })
  assert.equal(errKind(out), 'duplicate')
})

test('empty names and types are rejected', () => {
  const l = live([col('a')])
  assert.equal(errKind(runOut(l, { description: null, columns: [edit('  ')] })), 'empty-name')
  assert.equal(
    errKind(runOut(live([]), { description: null, columns: [edit('x', { id: 'new:1', added: true, type: '   ' })] })),
    'empty-type',
  )
  assert.equal(
    errKind(runOut(l, { description: null, columns: [edit('a', { type: '' })] })),
    'empty-type',
  )
})

// --- fkLabels/ukLabels: running FK1/FK2/… and UK1/UK2/… badges ----------
// The badge numbering shown in the table editor; one ordering test per
// helper pins the shared-number contract, the rest is presentation.

const fkRow = (name, definition, conkey) => ({ name, definition, conkey })
const nameByAttnum = new Map([
  [1, 'id'],
  [2, 'product_id'],
  [3, 'variant_id'],
  [4, 'warehouse_id'],
])
const labelsOf = (map, column) => (map.get(column) ?? []).map((f) => f.label)

test('fkLabels numbers constraints in order and shares the number across its columns', () => {
  const map = fkLabels(
    [
      fkRow('bom_product_fkey', 'FOREIGN KEY (product_id) REFERENCES products(id)', [2]),
      fkRow('stock_pair_fkey', 'FOREIGN KEY (variant_id, warehouse_id) REFERENCES stock(a, b)', [3, 4]),
    ],
    nameByAttnum,
  )
  assert.deepEqual(labelsOf(map, 'product_id'), ['FK1'])
  assert.deepEqual(labelsOf(map, 'variant_id'), ['FK2'])
  assert.deepEqual(labelsOf(map, 'warehouse_id'), ['FK2'], 'both columns of one FK share the number')
  assert.equal(map.get('product_id')[0].name, 'bom_product_fkey')
  assert.equal(map.get('product_id')[0].definition, 'FOREIGN KEY (product_id) REFERENCES products(id)')
})

test('ukLabels numbers unique keys in order and shares numbers across columns', () => {
  const map = ukLabels(
    [
      fkRow('bom_code_key', 'UNIQUE (code)', [2]),
      fkRow('idx_stock_pair', 'CREATE UNIQUE INDEX idx_stock_pair ON bom (variant_id, warehouse_id)', [3, 4]),
    ],
    new Map([
      [2, 'code'],
      [3, 'variant_id'],
      [4, 'warehouse_id'],
    ]),
  )
  assert.deepEqual((map.get('code') ?? []).map((u) => u.label), ['UK1'])
  assert.deepEqual((map.get('variant_id') ?? []).map((u) => u.label), ['UK2'])
  assert.deepEqual((map.get('warehouse_id') ?? []).map((u) => u.label), ['UK2'])
  assert.equal(map.get('code')[0].name, 'bom_code_key')
  assert.equal(map.get('code')[0].definition, 'UNIQUE (code)')
})
