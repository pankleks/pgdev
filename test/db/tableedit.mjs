// Table-editor live round-trip: change every editable property through the
// real diff, apply the generated change-only DDL, and compare the result to an
// independently created table with the desired shape. Also covers the guards
// that need a live catalog (locked/PK columns, non-tables, drift).
import { credentials, scratchDatabase, counters } from '../lib/db.mjs'

const base = await credentials()
const DB = `pgdev_tableedittest_${process.pid}`
const { pool, teardown } = await scratchDatabase(base, DB)
const { eq, ok, report } = counters()

const tableedit = await import('../../server/dist/catalog/tableedit.js')
const oidOfRel = async (name) =>
  (await pool.query(`SELECT $1::regclass::oid::text AS o`, [`public.${name}`])).rows[0]?.o

// Column shape fingerprint, used to compare the edited table with the expected
// one. Identity/generated are surfaced separately from the default expression.
const COLUMN_FP = `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
    a.attnotnull AS notnull,
    CASE WHEN a.attidentity <> '' THEN 'identity'
         WHEN a.attgenerated <> '' THEN 'generated'
         ELSE COALESCE(pg_get_expr(d.adbin, d.adrelid), '') END AS default_expr,
    COALESCE(col_description(a.attrelid, a.attnum), '') AS comment,
    a.attidentity AS identity, a.attgenerated AS generated
  FROM pg_attribute a
  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE a.attrelid = format('public.%I', $1::text)::regclass
    AND a.attnum > 0 AND NOT a.attisdropped
  ORDER BY a.attnum`
const TABLE_DESC = `SELECT COALESCE(obj_description(format('public.%I', $1::text)::regclass), '') AS description`

const cols = async (name) => (await pool.query(COLUMN_FP, [name])).rows
const tableDesc = async (name) => (await pool.query(TABLE_DESC, [name])).rows[0].description

// Input builders. `from` echoes a live column (optionally overriding fields);
// `added` is a brand-new row the user just typed.
const from = (c, over = {}) => ({
  id: c.id, name: c.name, type: c.type, nullable: c.nullable,
  defaultValue: c.defaultValue, description: c.description, ...over,
})
const added = (id, name, over = {}) => ({
  id, added: true, name, type: 'text', nullable: true, defaultValue: null, description: null, ...over,
})
const request = (state, columns, description = state.description) => ({
  fingerprint: state.fingerprint, description, columns,
})
async function outcome(fn) {
  try { return { ok: true, value: await fn() } } catch (e) { return { ok: false, error: e } }
}

// ---------------------------------------------------------------- fixtures
await pool.query(`CREATE TABLE te_all (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  keep integer,
  rename_me text,
  drop_me text,
  retype integer,
  nullable_col text NOT NULL,
  default_me integer DEFAULT 1,
  num numeric(10,2),
  desc_col text
)`)
await pool.query(`COMMENT ON TABLE te_all IS 'old table comment'`)
await pool.query(`COMMENT ON COLUMN te_all.desc_col IS 'old column comment'`)

console.log('== change every editable property ==')
let ddl
{
  const state = await tableedit.fetchTableEditState(pool, await oidOfRel('te_all'))
  const by = Object.fromEntries(state.columns.map((c) => [c.name, c]))
  const columns = [
    from(by.id),
    from(by.keep, { name: 'kept', type: 'bigint', nullable: false, description: 'keep note' }),
    from(by.rename_me, { name: 'renamed', type: 'varchar(50)', defaultValue: "'x'" }),
    // drop_me is omitted -> DROP COLUMN
    from(by.retype, { type: 'numeric(12,2)', defaultValue: '0' }),
    from(by.nullable_col, { nullable: true }),
    from(by.default_me, { defaultValue: null }),
    from(by.num, { type: 'numeric(14,3)' }),
    from(by.desc_col, { description: null }),
    added('new:1', 'new_col', { type: 'boolean', nullable: false, defaultValue: 'false' }),
    added('new:2', 'new_note', { description: 'added note' }),
  ]
  ddl = await tableedit.tableEditDdl(pool, await oidOfRel('te_all'), request(state, columns, 'new table comment'))
  ok('generates a change-only script', typeof ddl === 'string' && ddl.length > 0)

  // Every expected clause is present, in the documented safe order.
  ok('drops the omitted column', /DROP COLUMN "drop_me"/.test(ddl))
  ok('renames both columns', /RENAME COLUMN "keep" TO "kept"/.test(ddl) && /RENAME COLUMN "rename_me" TO "renamed"/.test(ddl))
  ok('changes varchar length', /ALTER COLUMN "renamed" TYPE varchar\(50\)/.test(ddl))
  ok('changes numeric precision/scale', /ALTER COLUMN "retype" TYPE numeric\(12,2\)/.test(ddl) && /ALTER COLUMN "num" TYPE numeric\(14,3\)/.test(ddl))
  ok('changes bigint type', /ALTER COLUMN "kept" TYPE bigint/.test(ddl))
  ok('sets and drops NOT NULL', /ALTER COLUMN "kept" SET NOT NULL/.test(ddl) && /ALTER COLUMN "nullable_col" DROP NOT NULL/.test(ddl))
  ok('sets and drops defaults', /ALTER COLUMN "renamed" SET DEFAULT 'x'/.test(ddl) && /ALTER COLUMN "retype" SET DEFAULT 0/.test(ddl) && /ALTER COLUMN "default_me" DROP DEFAULT/.test(ddl))
  ok('adds columns with default before NOT NULL', /ADD COLUMN "new_col" boolean DEFAULT false NOT NULL/.test(ddl) && /ADD COLUMN "new_note" text/.test(ddl))
  ok('writes column comments', /COMMENT ON COLUMN "public"\."te_all"\."kept" IS 'keep note'/.test(ddl) && /COMMENT ON COLUMN "public"\."te_all"\."new_note" IS 'added note'/.test(ddl))
  ok('clears a column comment', /COMMENT ON COLUMN "public"\."te_all"\."desc_col" IS NULL/.test(ddl))
  ok('writes the table comment', /COMMENT ON TABLE "public"\."te_all" IS 'new table comment'/.test(ddl))
  const order = [ddl.indexOf('DROP COLUMN'), ddl.indexOf('RENAME COLUMN'), ddl.indexOf('ADD COLUMN'), ddl.indexOf('COMMENT ON TABLE')]
  ok('emits drops, renames, adds, then comments', order.every((v, i) => v !== -1 && (i === 0 || v > order[i - 1])), JSON.stringify(order))
}

console.log('\n== applying the script produces the intended shape ==')
await pool.query(`CREATE TABLE te_all_expected (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kept bigint NOT NULL,
  renamed varchar(50) DEFAULT 'x',
  retype numeric(12,2) DEFAULT 0,
  nullable_col text,
  default_me integer,
  num numeric(14,3),
  desc_col text,
  new_col boolean DEFAULT false NOT NULL,
  new_note text
)`)
await pool.query(`COMMENT ON TABLE te_all_expected IS 'new table comment'`)
await pool.query(`COMMENT ON COLUMN te_all_expected.kept IS 'keep note'`)
await pool.query(`COMMENT ON COLUMN te_all_expected.new_note IS 'added note'`)
await pool.query(ddl)
eq('all column properties match the expected table', await cols('te_all'), await cols('te_all_expected'))
eq('table description matches', await tableDesc('te_all'), await tableDesc('te_all_expected'))

console.log('\n== no-op submits ==')
{
  const state = await tableedit.fetchTableEditState(pool, await oidOfRel('te_all'))
  const same = request(state, state.columns.map((c) => from(c)))
  const out = await tableedit.tableEditDdl(pool, await oidOfRel('te_all'), same)
  eq('an unchanged dialog returns null', out, null)
}

console.log('\n== default expressions with internal whitespace ==')
{
  await pool.query(`CREATE TABLE te_space (
    label text DEFAULT 'North  America',
    stamp timestamptz DEFAULT now(  )
  )`)
  const oid = await oidOfRel('te_space')
  const state = await tableedit.fetchTableEditState(pool, oid)
  const by = Object.fromEntries(state.columns.map((c) => [c.name, c]))

  // Echoing the catalog text must not count as an edit — the double space
  // inside the literal is data, not formatting.
  const same = await tableedit.tableEditDdl(pool, oid, request(state, [from(by.label), from(by.stamp)]))
  eq('a default with internal double spaces is not a phantom edit', same, null)

  // Changing the literal is a real edit, emitted verbatim.
  const changed = await tableedit.tableEditDdl(pool, oid, request(state, [
    from(by.label, { defaultValue: "'North America'" }), from(by.stamp),
  ]))
  ok('the literal change is emitted verbatim',
    typeof changed === 'string' && changed.includes(`SET DEFAULT 'North America'`), changed)
  await pool.query(changed)
  const after = await cols('te_space')
  eq('the applied default keeps exactly one space', after.find((c) => c.name === 'label').default_expr, `'North America'::text`)

  // And re-reading the edited table is stable again.
  const state2 = await tableedit.fetchTableEditState(pool, oid)
  const stable = await tableedit.tableEditDdl(pool, oid, request(state2, state2.columns.map((c) => from(c))))
  eq('the edited default is stable on re-read', stable, null)
}

console.log('\n== column identity is the catalog attnum, not the name ==')
{
  // A real column literally named `new:1` must not be mistaken for a row the
  // user just added — the editor's row tokens share no namespace with attnums.
  await pool.query(`CREATE TABLE te_ident ("new:1" integer, plain text)`)
  const oid = await oidOfRel('te_ident')
  const state = await tableedit.fetchTableEditState(pool, oid)
  ok('state identities are catalog attnums', state.columns.every((c) => /^\d+$/.test(c.id)),
    JSON.stringify(state.columns.map((c) => c.id)))

  const noop = await tableedit.tableEditDdl(pool, oid, request(state, state.columns.map((c) => from(c))))
  eq('a column named new:1 is not re-added', noop, null)

  const by = Object.fromEntries(state.columns.map((c) => [c.name, c]))
  const renamed = await tableedit.tableEditDdl(pool, oid, request(state, [
    from(by['new:1'], { name: 'renamed' }), from(by.plain),
  ]))
  ok('the awkward name renames through its identity',
    typeof renamed === 'string' && renamed.includes(`RENAME COLUMN "new:1" TO "renamed"`), renamed)
  await pool.query(renamed)

  // An added row claiming a live attnum is refused instead of generating an
  // ADD COLUMN that would collide with the existing column. The claimed live
  // row is omitted from the request so the ids themselves are unique.
  const state3 = await tableedit.fetchTableEditState(pool, oid)
  const [first, ...rest] = state3.columns
  const bad = await outcome(() => tableedit.tableEditDdl(pool, oid, request(state3, [
    ...rest.map((c) => from(c)),
    added(first.id, 'impostor'),
  ])))
  ok('an added row cannot reuse a live identity', !bad.ok && /already exists/i.test(bad.error.message),
    bad.ok ? 'no error' : bad.error.message)
}

console.log('\n== guards ==')
{
  const oid = await oidOfRel('te_all')
  const state = await tableedit.fetchTableEditState(pool, oid)

  const locked = await outcome(() => tableedit.tableEditDdl(pool, oid,
    request(state, state.columns.map((c) => (c.name === 'id' ? from(c, { type: 'bigint' }) : from(c))))))
  ok('rejects editing a locked identity column', !locked.ok && locked.error.statusCode === 400,
    locked.ok ? 'no error' : locked.error.message)

  // A plain (non-identity) primary key isolates the PK-specific guards.
  await pool.query(`CREATE TABLE te_pk (a integer PRIMARY KEY, b text)`)
  const pkOid = await oidOfRel('te_pk')
  const pkState = await tableedit.fetchTableEditState(pool, pkOid)
  const pkDrop = await outcome(() => tableedit.tableEditDdl(pool, pkOid,
    request(pkState, pkState.columns.filter((c) => c.name !== 'a').map((c) => from(c)))))
  ok('rejects dropping the primary-key column', !pkDrop.ok && /primary key/i.test(pkDrop.error.message),
    pkDrop.ok ? 'no error' : pkDrop.error.message)

  const pkNull = await outcome(() => tableedit.tableEditDdl(pool, pkOid,
    request(pkState, pkState.columns.map((c) => (c.name === 'a' ? from(c, { nullable: true }) : from(c))))))
  ok('rejects making the primary-key column nullable', !pkNull.ok && /primary key/i.test(pkNull.error.message),
    pkNull.ok ? 'no error' : pkNull.error.message)

  const stale = await outcome(() => tableedit.tableEditDdl(pool, oid,
    { ...request(state, state.columns.map((c) => from(c))), fingerprint: 'stale' }))
  ok('rejects a stale fingerprint', !stale.ok && stale.error.statusCode === 409,
    stale.ok ? 'no error' : stale.error.message)

  await pool.query(`CREATE VIEW te_view AS SELECT 1 AS one`)
  const onView = await outcome(async () => tableedit.fetchTableEditState(pool, await oidOfRel('te_view')))
  ok('rejects a view', !onView.ok && onView.error.statusCode === 400,
    onView.ok ? 'no error' : onView.error.message)

  await pool.query(`CREATE TABLE te_part (a integer) PARTITION BY RANGE (a)`)
  await pool.query(`CREATE TABLE te_part_1 PARTITION OF te_part FOR VALUES FROM (0) TO (10)`)
  const onPartition = await outcome(async () => tableedit.fetchTableEditState(pool, await oidOfRel('te_part_1')))
  ok('rejects a partition', !onPartition.ok && onPartition.error.statusCode === 400,
    onPartition.ok ? 'no error' : onPartition.error.message)
}

// ------------------------------------------------------------------ teardown
const left = await teardown()
console.log(`\nleftover pgdev_% databases: ${JSON.stringify(left)}`)
process.exit(report() ? 0 : 1)
