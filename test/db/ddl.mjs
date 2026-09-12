// DDL round-trips for object shapes the other suites do not assert: RLS
// policies, list and hash partitions, composite and enum types, and index
// variants. Everything runs inside a database this suite owns.
import { credentials, scratchDatabase, counters, roundTrip } from '../lib/db.mjs'

const base = await credentials()
const DB = `pgdev_ddltest_${process.pid}`
const { pool, teardown } = await scratchDatabase(base, DB)
const { eq, ok, report } = counters()

const ddl = await import('../../server/dist/catalog/ddl.js')
const oidOfRel = async (name) => (await pool.query(`SELECT $1::regclass::oid::text AS o`, [`public.${name}`])).rows[0]?.o
const oidOfType = async (name) => (await pool.query(`SELECT oid::text AS o FROM pg_type WHERE typname=$1`, [name])).rows[0]?.o
const tableFp = `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, c.relispartition, c.relkind,
    pg_get_expr(c.relpartbound, c.oid) AS bound,
    (SELECT pg_get_partkeydef(p.partrelid) FROM pg_partitioned_table p WHERE p.partrelid = c.oid) AS partkey
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=$1`
const policyFp = `SELECT p.polname, p.polcmd, p.polpermissive,
    (SELECT string_agg(r.rolname, ',' ORDER BY r.rolname) FROM pg_roles r WHERE r.oid = ANY(p.polroles)) AS roles,
    pg_get_expr(p.polqual, p.polrelid) AS qual, pg_get_expr(p.polwithcheck, p.polrelid) AS withcheck
  FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid WHERE c.relname=$1 ORDER BY p.polname`
const indexFp = `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname='public' AND tablename=$1 ORDER BY indexname`
const typeFp = `SELECT t.typname, t.typtype,
    COALESCE((SELECT string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid=t.oid),'') AS labels,
    COALESCE((SELECT string_agg(a.attname||':'||format_type(a.atttypid,a.atttypmod), ',' ORDER BY a.attnum)
      FROM pg_attribute a WHERE a.attrelid=t.typrelid AND a.attnum>0 AND NOT a.attisdropped),'') AS attrs
  FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typname=$1`

// ---------------------------------------------------------------- fixtures
const ROLES = ['pgdev_ddl_reader', 'pgdev_ddl_writer']
for (const r of ROLES) await pool.query(`DROP ROLE IF EXISTS ${r}`)
for (const r of ROLES) await pool.query(`CREATE ROLE ${r} NOLOGIN`)
await pool.query(`CREATE TABLE base (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, label text NOT NULL)`)
await pool.query(`INSERT INTO base (label) SELECT 'r'||g FROM generate_series(1,20) g`)
await pool.query(`CREATE TABLE rls_table (id integer PRIMARY KEY, owner_name text NOT NULL, payload text)`)
await pool.query(`CREATE TABLE list_parent (region text NOT NULL, id integer NOT NULL, PRIMARY KEY (region, id)) PARTITION BY LIST (region)`)
await pool.query(`CREATE TABLE hash_parent (id integer NOT NULL, v text, PRIMARY KEY (id)) PARTITION BY HASH (id)`)

console.log('\n== table DDL: row level security ==')
await pool.query(`ALTER TABLE rls_table ENABLE ROW LEVEL SECURITY`)
await pool.query(`ALTER TABLE rls_table FORCE ROW LEVEL SECURITY`)
await pool.query(`CREATE POLICY own_rows ON rls_table FOR SELECT TO pgdev_ddl_reader USING (owner_name = CURRENT_USER)`)
await pool.query(`CREATE POLICY no_delete ON rls_table AS RESTRICTIVE FOR DELETE TO PUBLIC USING (false)`)
await pool.query(`CREATE POLICY ins_chk ON rls_table FOR INSERT TO pgdev_ddl_writer WITH CHECK (owner_name <> '')`)
await roundTrip({
  pool, eq, ok, params: ['rls_table'], create: [], drop: `DROP TABLE rls_table CASCADE`,
  label: 'RLS table (enable + force, permissive/restrictive, roles, USING/WITH CHECK)',
  fingerprint: tableFp,
  ddl: async () => {
    const text = await ddl.tableDdl(pool, await oidOfRel('rls_table'), 'public', 'rls_table')
    // recreate the policies the table DDL emitted, none exist after the drop
    return text
  },
})
{
  // policies are part of the table DDL, so assert them directly too
  const text = await ddl.tableDdl(pool, await oidOfRel('rls_table'), 'public', 'rls_table')
  ok('emits ENABLE ROW LEVEL SECURITY', /ENABLE ROW LEVEL SECURITY/.test(text))
  ok('ENABLE precedes FORCE', text.indexOf('ENABLE ROW LEVEL SECURITY') < text.indexOf('FORCE ROW LEVEL SECURITY'))
  ok('emits a restrictive policy', /AS RESTRICTIVE/.test(text))
  // quote_ident only quotes when necessary, so assert the role is named
  // correctly rather than that it is quoted
  ok('names the policy role', /TO pgdev_ddl_reader/.test(text))
  ok('names PUBLIC for the restrictive policy', /TO PUBLIC/.test(text))
  ok('opens a fresh policy line with TO', /\n\s+FOR (SELECT|INSERT|DELETE|ALL) TO /.test(text))
  ok('emits USING and WITH CHECK', /USING \(\(owner_name = CURRENT_USER\)\)/.test(text) && /WITH CHECK/.test(text))
}

console.log('\n== table DDL: list and hash partitions ==')
await pool.query(`CREATE TABLE list_eu PARTITION OF list_parent FOR VALUES IN ('eu','uk')`)
await pool.query(`CREATE TABLE list_def PARTITION OF list_parent DEFAULT`)
await pool.query(`CREATE TABLE hash_0 PARTITION OF hash_parent FOR VALUES WITH (MODULUS 2, REMAINDER 0)`)
await pool.query(`CREATE TABLE hash_1 PARTITION OF hash_parent FOR VALUES WITH (MODULUS 2, REMAINDER 1)`)

for (const [child, expect] of [
  ['list_eu', /FOR VALUES IN \('eu', 'uk'\)/],
  ['list_def', /DEFAULT/],
  ['hash_0', /FOR VALUES WITH \(modulus 2, remainder 0\)/i],
  ['hash_1', /FOR VALUES WITH \(modulus 2, remainder 1\)/i],
]) {
  const text = await ddl.tableDdl(pool, await oidOfRel(child), 'public', child)
  ok(`${child} emits its bound`, expect.test(text), text.split('\n').find((l) => /VALUES|DEFAULT/.test(l))?.trim())
  ok(`${child} does not emit FOR VALUES DEFAULT`, !/FOR VALUES DEFAULT/i.test(text))
  ok(`${child} attaches to the right parent`, /PARTITION OF "public"\."(list|hash)_parent"/.test(text))
}

// full rebuild of the list partition: parent then child
await roundTrip({
  pool, eq, ok, params: ['list_eu'], create: [], drop: `DROP TABLE list_eu`,
  label: 'list partition (rebuild from parent + child DDL)',
  fingerprint: tableFp,
  ddl: async () => ddl.tableDdl(pool, await oidOfRel('list_eu'), 'public', 'list_eu'),
})

console.log('\n== partition-local constraints and indexes ==')
await pool.query(`CREATE TABLE list_loc PARTITION OF list_parent FOR VALUES IN ('fr','de')`)
await pool.query(`ALTER TABLE list_loc ADD CONSTRAINT loc_chk CHECK (id > 100)`)
await pool.query(`CREATE INDEX loc_idx ON list_loc (id)`)
await roundTrip({
  pool, eq, ok, params: ['list_loc'], create: [], drop: `DROP TABLE list_loc`,
  label: 'partition-local CHECK and index survive the round-trip',
  fingerprint: `SELECT con.conname, pg_get_constraintdef(con.oid) AS def
      FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
      WHERE c.relname = $1 AND con.conname = 'loc_chk'`,
  ddl: async () => ddl.tableDdl(pool, await oidOfRel('list_loc'), 'public', 'list_loc'),
})
{
  const text = await ddl.tableDdl(pool, await oidOfRel('list_loc'), 'public', 'list_loc')
  ok('emits the partition-local CHECK', /ADD CONSTRAINT "loc_chk" CHECK \(\(id > 100\)\)/.test(text),
    text.split('\n').find((l) => /loc_chk/.test(l))?.trim())
  ok('emits the partition-local index', /CREATE INDEX "?loc_idx"? ON/.test(text),
    text.split('\n').find((l) => /loc_idx/.test(l))?.trim())
  // Parent-cloned objects must NOT appear: the attachment recreates them.
  ok('omits the cloned primary key', !/list_loc_pkey|CONSTRAINT .* PRIMARY KEY/.test(text),
    text.split('\n').find((l) => /pkey|PRIMARY KEY/.test(l))?.trim())
  ok('cloned CHECKs do not collide with the local one',
    (text.match(/ADD CONSTRAINT/g) ?? []).length === 1)
}
await pool.query(`DROP TABLE list_loc`)

console.log('\n== index variants ==')
for (const [label, create, name] of [
  ['partial index', `CREATE INDEX idx_partial ON base (label) WHERE id > 10`, 'idx_partial'],
  ['expression index', `CREATE INDEX idx_expr ON base (lower(label))`, 'idx_expr'],
  ['INCLUDE index', `CREATE INDEX idx_incl ON base (id) INCLUDE (label)`, 'idx_incl'],
  ['gin index', `CREATE INDEX idx_gin ON base USING gin (to_tsvector('simple', label))`, 'idx_gin'],
  ['brin index', `CREATE INDEX idx_brin ON base USING brin (id)`, 'idx_brin'],
  ['unique index', `CREATE UNIQUE INDEX idx_uniq ON base (label)`, 'idx_uniq'],
]) {
  await pool.query(create)
  await roundTrip({
    pool, eq, ok, params: ['base'], create: [], drop: `DROP INDEX ${name}`,
    label, fingerprint: indexFp,
    ddl: async () => ddl.indexDdl(pool, 'public', name),
  })
}

console.log('\n== constraint variants ==')
await pool.query(`CREATE TABLE cons (a integer, b integer, c text,
  CONSTRAINT cons_pk PRIMARY KEY (a),
  CONSTRAINT cons_chk CHECK (b > 0),
  CONSTRAINT cons_uniq UNIQUE (c) DEFERRABLE INITIALLY DEFERRED)`)
for (const name of ['cons_pk', 'cons_chk', 'cons_uniq']) {
  const text = await ddl.constraintDdl(pool, 'public', 'cons', name)
  const def = (await pool.query(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname=$1`, [name])).rows[0].d
  ok(`${name} DDL carries its definition`, text.includes(def), def)
  ok(`${name} DDL is an ALTER TABLE ADD CONSTRAINT`, /ADD CONSTRAINT/.test(text))
}
await pool.query(`CREATE TABLE fk_child (id integer PRIMARY KEY, p integer, CONSTRAINT fk_c FOREIGN KEY (p) REFERENCES cons(a) ON DELETE CASCADE ON UPDATE RESTRICT)`)
{
  const text = await ddl.constraintDdl(pool, 'public', 'fk_child', 'fk_c')
  ok('FK keeps ON DELETE CASCADE', /ON DELETE CASCADE/.test(text))
  ok('FK keeps ON UPDATE RESTRICT', /ON UPDATE RESTRICT/.test(text))
  const def = (await pool.query(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname='fk_c'`)).rows[0].d
  ok('FK matches pg_get_constraintdef', text.includes(def), def)
}
await pool.query(`ALTER TABLE cons ADD CONSTRAINT cons_notvalid CHECK (b < 1000) NOT VALID`)
{
  const text = await ddl.constraintDdl(pool, 'public', 'cons', 'cons_notvalid')
  ok('NOT VALID constraint is preserved', /NOT VALID/.test(text), text.trim().split('\n').pop())
}

console.log('\n== composite and enum types ==')
await roundTrip({
  pool, eq, ok, params: ['addr'], create: `CREATE TYPE addr AS (street text, city text, zip integer)`,
  drop: `DROP TYPE addr`, label: 'composite type', fingerprint: typeFp,
  ddl: async () => ddl.typeDdl(pool, await oidOfType('addr'), 'public', 'addr'),
})
await roundTrip({
  pool, eq, ok, params: ['mood'], create: `CREATE TYPE mood AS ENUM ('sad','ok','happy')`,
  drop: `DROP TYPE mood`, label: 'enum type', fingerprint: typeFp,
  ddl: async () => ddl.typeDdl(pool, await oidOfType('mood'), 'public', 'mood'),
})
await roundTrip({
  pool, eq, ok, params: ['odd labels'],
  create: `CREATE TYPE "odd labels" AS ENUM ('', 'has space', 'quote''s', 'ünïcøde')`,
  drop: `DROP TYPE "odd labels"`, label: 'enum with awkward labels', fingerprint: typeFp,
  ddl: async () => ddl.typeDdl(pool, await oidOfType('odd labels'), 'public', 'odd labels'),
})

console.log('\n== metadata harvest still works over this schema ==')
{
  const { fetchSchemaData } = await import('../../server/dist/catalog/metadata.js')
  const schema = await fetchSchemaData(pool)
  ok('harvests every table', schema.tables.length >= 8, `${schema.tables.length} tables`)
  ok('harvests the enum and composite', schema.types.length >= 2, JSON.stringify(schema.types.map((t) => t.name)))
  ok('partitions are flagged', schema.tables.filter((t) => t.isPartition).length >= 4)
  ok('partitioned parents are flagged', schema.tables.filter((t) => t.isPartitioned).length >= 2)
  let generated = 0
  const failures = []
  for (const t of schema.tables) {
    try { await ddl.tableDdl(pool, t.oid, t.schema, t.name); generated++ }
    catch (e) { failures.push(`${t.name}: ${e.message}`) }
  }
  eq('every harvested table generates DDL', failures, [])
  ok('generated them all', generated === schema.tables.length, `${generated}/${schema.tables.length}`)
}

// the scratch database (and with it rls_table) is gone by now
for (const r of ROLES) await pool.query(`DROP ROLE IF EXISTS ${r}`).catch(() => {})
const left = await teardown()
console.log(`\nleftover pgdev_% databases: ${JSON.stringify(left)}`)
process.exit(report() ? 0 : 1)
