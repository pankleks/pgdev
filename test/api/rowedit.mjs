// Live API suite: the editors — the table editor (state reads, no-op,
// stale-fingerprint conflicts, rename and numeric retype with apply) and
// the row editor (`editable` metadata, single-row UPDATE transport, NULL,
// temporal and array-literal writes, every rejection, and saves joining an
// open transaction).
import { boot, Client } from './setup.mjs'
import { counters } from '../lib/db.mjs'

const { base, DB, call, cleanup } = await boot('rowedit')
const { eq, ok, report } = counters()

console.log('== connect ==')
const conn = await call('POST', '/api/connections', {
  host: base.host, port: base.port, database: DB, user: base.user, password: base.password, ssl: false,
})
eq('connection opens', conn.status, 200)
const id = conn.body.id
if (!id) { console.log('cannot continue'); process.exit(1) }

const q = (sql, tabKey, maxRows) =>
  call('POST', `/api/connections/${id}/query`,
    { sql, tabKey, ...(maxRows === undefined ? {} : { maxRows }) })
const schema = await call('GET', `/api/connections/${id}/schema`)
eq('schema status', schema.status, 200)

console.log('\n== table editor ==')
{
  // Only ordinary/partitioned tables are editable: a view is rejected.
  const viewOid = schema.body.views.find((v) => v.name === 'v_emp').oid
  const onView = await call('GET', `/api/connections/${id}/tableedit/${viewOid}`)
  eq('table editor rejects a view', onView.status, 400)

  await q('CREATE TABLE tableedit_probe (a integer, b text, n numeric(10,2))', 'te0')
  const probeOid = (await q("SELECT 'tableedit_probe'::regclass::oid::text AS o", 'te0')).body.results[0].rows[0][0]
  const state = await call('GET', `/api/connections/${id}/tableedit/${probeOid}`)
  eq('table editor reads state', state.status, 200)
  ok('state carries a fingerprint', typeof state.body.fingerprint === 'string' && state.body.fingerprint.length > 0)

  const toRequest = (s) => ({
    description: null,
    fingerprint: s.fingerprint,
    columns: s.columns.map((c) => ({
      id: c.id, name: c.name, type: c.type, nullable: c.nullable,
      defaultValue: c.defaultValue, description: c.description,
    })),
  })
  const unchanged = await call('POST', `/api/connections/${id}/tableedit/${probeOid}`, toRequest(state.body))
  eq('no changes returns null ddl', unchanged.body.ddl, null)

  // A column added after the dialog loaded must not be silently dropped by a
  // diff against the stale column set.
  await q('ALTER TABLE tableedit_probe ADD COLUMN c boolean', 'te1')
  const stale = await call('POST', `/api/connections/${id}/tableedit/${probeOid}`, toRequest(state.body))
  eq('stale editor state is rejected', stale.status, 409)
  ok('conflict asks for a reload', /reopen|reload|changed/i.test(stale.body.error), stale.body.error)

  // Reloading picks up the new column, and a rename then applies cleanly.
  const fresh = await call('GET', `/api/connections/${id}/tableedit/${probeOid}`)
  const renamePayload = toRequest(fresh.body)
  renamePayload.columns = renamePayload.columns.map((c) => (c.name === 'a' ? { ...c, name: 'a2' } : c))
  const renamed = await call('POST', `/api/connections/${id}/tableedit/${probeOid}`, renamePayload)
  eq('fresh edit is accepted', renamed.status, 200)
  ok('emits the rename', /RENAME COLUMN "a" TO "a2"/.test(renamed.body.ddl), renamed.body.ddl)

  // Precision/scale: changing a numeric's precision must round-trip and the
  // applied type must render back canonically.
  const fresh2 = await call('GET', `/api/connections/${id}/tableedit/${probeOid}`)
  const scalePayload = toRequest(fresh2.body)
  scalePayload.columns = scalePayload.columns.map((c) => (c.name === 'n' ? { ...c, type: 'numeric(12,2)' } : c))
  const retyped = await call('POST', `/api/connections/${id}/tableedit/${probeOid}`, scalePayload)
  eq('numeric precision change is accepted', retyped.status, 200)
  ok('emits the numeric type change', /ALTER COLUMN "n" TYPE numeric\(12,2\)/.test(retyped.body.ddl), retyped.body.ddl)
  await q(retyped.body.ddl, 'te3')
  const appliedType = (await q(
    `SELECT format_type(atttypid, atttypmod) AS t FROM pg_attribute
     WHERE attrelid='tableedit_probe'::regclass AND attname='n'`, 'te4',
  )).body.results[0].rows[0][0]
  eq('applied numeric type is canonical', appliedType, 'numeric(12,2)')

  const noFp = await call('POST', `/api/connections/${id}/tableedit/${probeOid}`, { description: null, columns: [] })
  eq('missing fingerprint is rejected', noFp.status, 400)

  await q('DROP TABLE tableedit_probe', 'te2')
}

console.log('\n== row editor ==')
{
  await q(`CREATE TABLE rowedit_probe (
    id serial PRIMARY KEY,
    label text NOT NULL,
    qty numeric(10,2),
    active boolean,
    due_at timestamptz,
    payload jsonb,
    nums integer[],
    tags text[],
    flags boolean[],
    blob bytea,
    total numeric GENERATED ALWAYS AS (qty * 2) STORED
  )`, 're0')
  await q(`INSERT INTO rowedit_probe (label, qty, active, due_at, payload, nums, tags, flags) VALUES
    ('first', 1.50, true, '2024-01-15 10:30:00+00', '{"b":2,"a":1}', '{10,20}', '{red,green}', '{TRUE,FALSE}'),
    ('second', NULL, NULL, NULL, NULL, NULL, NULL, NULL)`, 're0')

  const grid = (await q('SELECT * FROM rowedit_probe ORDER BY id', 're1')).body.results[0]
  ok('editable metadata present', !!grid.editable, JSON.stringify(grid.editable))
  eq('editable table identity', [grid.editable?.schema, grid.editable?.table], ['public', 'rowedit_probe'])
  eq('editable primary key', grid.editable?.pk, ['id'])
  const editableByName = new Map((grid.editable?.columns ?? []).map((c) => [c.name, c]))
  eq('pk column flagged', editableByName.get('id')?.pk, true)
  eq('generated column flagged', editableByName.get('total')?.generated, true)
  eq('not-null column is not nullable', editableByName.get('label')?.nullable, false)
  eq('nullable column is flagged', editableByName.get('qty')?.nullable, true)
  ok('plain columns listed', ['label', 'payload', 'due_at'].every((n) => editableByName.has(n)))

  // Boolean, integer and text arrays travel as PostgreSQL literals, so the
  // row editor edits them in a single-line control instead of a JSON value.
  const arrayGrid = (await q('SELECT id, nums, tags, flags FROM rowedit_probe ORDER BY id', 're-array'))
    .body.results[0]
  eq('integer arrays arrive as literals', arrayGrid.rows[0][1], '{10,20}')
  eq('text arrays arrive as literals', arrayGrid.rows[0][2], '{red,green}')
  eq('boolean arrays arrive as PG literals', arrayGrid.rows[0][3], '{t,f}')

  const explicit = (await q('SELECT id, label FROM rowedit_probe', 're2')).body.results[0]
  ok('explicit column list is editable', !!explicit.editable)
  eq('only selected columns are offered', explicit.editable.columns.map((c) => c.name), ['id', 'label'])

  const noPk = (await q('SELECT label FROM rowedit_probe', 're3')).body.results[0]
  eq('a result without the primary key is not editable', noPk.editable ?? null, null)
  const aliased = (await q('SELECT id AS ident, label FROM rowedit_probe', 're4')).body.results[0]
  eq('an aliased primary key is not editable', aliased.editable ?? null, null)
  const expr = (await q('SELECT id, upper(label) AS u FROM rowedit_probe', 're5')).body.results[0]
  eq('an expression in the select list disables editing', expr.editable ?? null, null)
  const joined = (await q(
    'SELECT e.id, e.first_name FROM employees e JOIN departments d ON d.id = e.department_id', 're6',
  )).body.results[0]
  eq('a join is not editable', joined.editable ?? null, null)
  const view = (await q('SELECT * FROM v_emp', 're7')).body.results[0]
  eq('a view is not editable', view.editable ?? null, null)

  const rowUpdate = (body) => call('POST', `/api/connections/${id}/row-update`, body)

  await q(`
    CREATE TABLE rowedit_parent (id integer PRIMARY KEY, label text);
    INSERT INTO rowedit_parent VALUES (1, 'parent');
  `, 're-inheritance')
  const beforeChild = (await q('SELECT * FROM rowedit_parent', 're-inheritance')).body.results[0]
  ok('ordinary leaf table is initially editable', !!beforeChild.editable)
  await q(`
    CREATE TABLE rowedit_child (PRIMARY KEY (id)) INHERITS (rowedit_parent);
    INSERT INTO rowedit_child VALUES (1, 'child');
    CREATE TABLE rowedit_partitioned (id integer PRIMARY KEY, label text) PARTITION BY RANGE (id);
    CREATE TABLE rowedit_partition PARTITION OF rowedit_partitioned FOR VALUES FROM (0) TO (10);
    INSERT INTO rowedit_partitioned VALUES (1, 'partition');
  `, 're-inheritance')
  const inherited = (await q('SELECT * FROM rowedit_parent ORDER BY label', 're-inheritance')).body.results[0]
  eq('inheritance parent contains duplicate keys', inherited.rows, [[1, 'child'], [1, 'parent']])
  eq('inheritance parent has no edit buttons', inherited.editable ?? null, null)
  const staleParentEdit = await rowUpdate({
    schema: beforeChild.editable.schema, table: beforeChild.editable.table,
    key: { id: 1 }, set: { label: 'wrong' },
  })
  eq('stale parent metadata cannot authorize an update', staleParentEdit.status, 400)
  eq('rejected parent edit changes no rows',
    (await q('SELECT * FROM rowedit_parent ORDER BY label', 're-inheritance')).body.results[0].rows,
    [[1, 'child'], [1, 'parent']])
  const leaf = (await q('SELECT * FROM rowedit_child', 're-inheritance')).body.results[0]
  ok('inheritance leaf with its own primary key remains editable', !!leaf.editable)
  const partitioned = (await q('SELECT * FROM rowedit_partitioned', 're-partitioned')).body.results[0]
  ok('partitioned parent remains editable', !!partitioned.editable)
  eq('partitioned parent update succeeds', (await rowUpdate({
    schema: 'public', table: 'rowedit_partitioned', key: { id: 1 }, set: { label: 'changed' },
  })).status, 200)
  eq('partition row is updated',
    (await q('SELECT label FROM rowedit_partition', 're-partitioned')).body.results[0].rows, [['changed']])
  await q('DROP TABLE rowedit_child, rowedit_parent, rowedit_partitioned CASCADE', 're-inheritance')

  const watcher = new Client({ ...base, database: DB })
  await watcher.connect()
  try {
    // Result identity must survive later search_path changes, including the
    // reset at COMMIT. Both tables deliberately have the same key and columns.
    await watcher.query(`
      CREATE SCHEMA rowedit_other;
      CREATE TABLE rowedit_other.rowedit_probe (id integer PRIMARY KEY, label text);
      INSERT INTO rowedit_other.rowedit_probe VALUES (1, 'shadow');
    `)
    try {
      const batch = await q(`
        BEGIN;
        SET LOCAL search_path = public;
        SELECT id, label FROM rowedit_probe WHERE id = 1;
        SET LOCAL search_path = rowedit_other;
        SELECT id, label FROM rowedit_probe WHERE id = 1;
        SELECT id, label FROM rowedit_probe WHERE false;
        COMMIT;
      `, 're-searchpath')
      eq('search_path batch succeeds', batch.status, 200)
      const grids = batch.body.results.filter((r) => r.kind === 'data')
      eq('each result keeps the schema it read', grids.map((g) => g.editable?.schema),
        ['public', 'rowedit_other', 'rowedit_other'])
      eq('same-named tables return their own rows', grids.map((g) => g.rows),
        [[[1, 'first']], [[1, 'shadow']], []])

      const source = grids[1].editable
      const edited = await rowUpdate({
        schema: source?.schema, table: source?.table, key: { id: 1 }, set: { label: 'edited shadow' },
      })
      eq('edit using result metadata succeeds', edited.status, 200)
      eq('the edit reaches only the selected table', (await watcher.query(`
        SELECT label FROM public.rowedit_probe WHERE id = 1
        UNION ALL SELECT label FROM rowedit_other.rowedit_probe WHERE id = 1
      `)).rows.map((r) => r.label), ['first', 'edited shadow'])

      const replaced = await q(`
        SELECT * FROM rowedit_other.rowedit_probe;
        DROP TABLE rowedit_other.rowedit_probe;
        CREATE TABLE rowedit_other.rowedit_probe (id integer PRIMARY KEY, label text);
      `, 're-replaced')
      eq('table replacement batch succeeds', replaced.status, 200)
      eq('a replaced table is not mistaken for the result source',
        replaced.body.results[0].editable ?? null, null)
    } finally {
      await watcher.query('DROP SCHEMA rowedit_other CASCADE')
    }

    const upd = await rowUpdate({
      schema: 'public', table: 'rowedit_probe', key: { id: 1 },
      set: { label: 'FIRST', qty: '2.25', active: false, payload: '{"x":1}' },
    })
    eq('update status', upd.status, 200)
    eq('RETURNING reflects the stored values',
      [upd.body.row.label, upd.body.row.qty, upd.body.row.active, upd.body.row.payload, upd.body.row.total],
      ['FIRST', '2.25', false, '{"x": 1}', '4.50'])
    eq('autocommit save reports no transaction', upd.body.transactionOpen, false)
    eq('the change is visible to other connections',
      (await watcher.query('SELECT label FROM rowedit_probe WHERE id = 1')).rows[0].label, 'FIRST')

    const nulled = await rowUpdate({
      schema: 'public', table: 'rowedit_probe', key: { id: 1 }, set: { qty: null, active: null },
    })
    eq('NULL set status', nulled.status, 200)
    eq('NULL values are stored', [nulled.body.row.qty, nulled.body.row.active], [null, null])

    const arrays = await rowUpdate({
      schema: 'public', table: 'rowedit_probe', key: { id: 1 },
      set: { nums: '{10, 30}', tags: '{"a b",c}', flags: '{TRUE,FALSE}' },
    })
    eq('array update status', arrays.status, 200)
    eq('arrays round-trip as literals',
      [arrays.body.row.nums, arrays.body.row.tags, arrays.body.row.flags],
      ['{10,30}', '{"a b",c}', '{t,f}'])
    eq('the stored arrays are visible to other connections',
      (await watcher.query(
        'SELECT nums::text AS n, tags::text AS t, flags::text AS f FROM rowedit_probe WHERE id = 1',
      )).rows[0],
      { n: '{10,30}', t: '{"a b",c}', f: '{t,f}' })

    // timestamptz: the control sends wall time without an offset, PostgreSQL
    // interprets it in the session timezone, and the text comes back raw.
    const timed = await rowUpdate({
      schema: 'public', table: 'rowedit_probe', key: { id: 1 }, set: { due_at: '2024-06-01T12:00:00' },
    })
    eq('temporal update status', timed.status, 200)
    ok('temporal cells are PostgreSQL text, not ISO Z',
      /^2024-06-01 \d{2}:\d{2}:\d{2}[+-]/.test(timed.body.row.due_at), timed.body.row.due_at)
    eq('the stored instant matches the wall time in the session timezone',
      (await watcher.query(
        "SELECT due_at = '2024-06-01T12:00:00'::timestamptz AS same FROM rowedit_probe WHERE id = 1",
      )).rows[0].same, true)

    // The browser payload is advisory: every rejection below proves the
    // server re-validates against the live catalog.
    const reject = async (name, body, status) => {
      const r = await rowUpdate(body)
      eq(name, r.status, status)
    }
    await reject('a key that is not the primary key is rejected',
      { schema: 'public', table: 'rowedit_probe', key: { label: 'FIRST' }, set: { label: 'x' } }, 400)
    await reject('editing the primary key is rejected',
      { schema: 'public', table: 'rowedit_probe', key: { id: 1 }, set: { id: 99 } }, 400)
    await reject('editing a generated column is rejected',
      { schema: 'public', table: 'rowedit_probe', key: { id: 1 }, set: { total: '5' } }, 400)
    await reject('editing binary data is rejected',
      { schema: 'public', table: 'rowedit_probe', key: { id: 1 }, set: { blob: 'x' } }, 400)
    await reject('an unknown column is rejected',
      { schema: 'public', table: 'rowedit_probe', key: { id: 1 }, set: { nope: 'x' } }, 400)
    await reject('an empty change set is rejected',
      { schema: 'public', table: 'rowedit_probe', key: { id: 1 }, set: {} }, 400)
    await reject('malformed JSON is reported by PostgreSQL',
      { schema: 'public', table: 'rowedit_probe', key: { id: 1 }, set: { payload: '{oops' } }, 400)
    await reject('a missing row reports not found',
      { schema: 'public', table: 'rowedit_probe', key: { id: 999999 }, set: { label: 'x' } }, 404)
    await reject('an unknown table is rejected',
      { schema: 'public', table: 'no_such_table', key: { id: 1 }, set: { label: 'x' } }, 400)
    await reject('a non-table target is rejected',
      { schema: 'public', table: 'v_emp', key: { id: 1 }, set: { first_name: 'x' } }, 400)
    await reject('a malformed body is rejected',
      { schema: 'public', table: 'rowedit_probe', key: 'x', set: {} }, 400)

    // SAVE inside the tab's open transaction: invisible outside, ended by
    // COMMIT/ROLLBACK, and a failed statement aborts it like psql.
    eq('begin a transaction for the tab', (await q('BEGIN', 'retx')).body.transactionOpen, true)
    const inside = await rowUpdate({
      tabKey: 'retx', schema: 'public', table: 'rowedit_probe', key: { id: 2 }, set: { label: 'INSIDE' },
    })
    eq('save inside the transaction succeeds', inside.status, 200)
    eq('the response reports the open transaction', inside.body.transactionOpen, true)
    eq('the tab sees its own edit',
      (await q('SELECT label FROM rowedit_probe WHERE id = 2', 'retx')).body.results[0].rows[0][0], 'INSIDE')
    eq('other connections do not see it yet',
      (await watcher.query('SELECT label FROM rowedit_probe WHERE id = 2')).rows[0].label, 'second')
    eq('commit the transaction', (await q('COMMIT', 'retx')).body.transactionOpen, false)
    eq('the committed edit is visible to others',
      (await watcher.query('SELECT label FROM rowedit_probe WHERE id = 2')).rows[0].label, 'INSIDE')

    eq('begin again', (await q('BEGIN', 'retx')).body.transactionOpen, true)
    const bad = await rowUpdate({
      tabKey: 'retx', schema: 'public', table: 'rowedit_probe', key: { id: 2 }, set: { label: null },
    })
    eq('a constraint violation is reported', bad.status, 400)
    eq('the aborted transaction stays open for ROLLBACK',
      (await q('SELECT 1', 'retx')).body.code, '25P02')
    eq('rollback closes it', (await q('ROLLBACK', 'retx')).body.transactionOpen, false)
    eq('the rolled-back edit is gone',
      (await watcher.query('SELECT label FROM rowedit_probe WHERE id = 2')).rows[0].label, 'INSIDE')

    // A rejected plan never reaches the client, so the transaction survives.
    eq('begin for the rejection case', (await q('BEGIN', 'retx')).body.transactionOpen, true)
    const rejectedInTxn = await rowUpdate({
      tabKey: 'retx', schema: 'public', table: 'rowedit_probe', key: { id: 2 }, set: { total: '5' },
    })
    eq('a rejected save inside a transaction is a 400', rejectedInTxn.status, 400)
    eq('the transaction is still usable', (await q('SELECT 1', 'retx')).status, 200)
    eq('close the transaction', (await q('ROLLBACK', 'retx')).body.transactionOpen, false)
  } finally {
    await watcher.end()
  }

  await q('DROP TABLE rowedit_probe', 're8')
}

console.log('\n== disconnect ==')
const del = await call('DELETE', `/api/connections/${id}`)
eq('connection closes', del.status, 200)
const gone = await call('GET', `/api/connections/${id}/schema`)
eq('closed connection is unknown', gone.status, 404)

// ------------------------------------------------------------------- teardown
const left = await cleanup()
console.log(`\nleftover pgdev_% databases: ${JSON.stringify(left)}`)
process.exit(report() ? 0 : 1)
