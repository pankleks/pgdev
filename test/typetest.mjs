// Round-trips the remaining DDL paths (ranges, composites, domains,
// sub-partitioning) inside a database this harness owns.

// Credentials: PGDEV_TEST_URL from the environment or the repo .env.
import { credentials, Client, Pool } from './lib/db.mjs'
const base = await credentials()

const DB = 'pgdev_typetest'

const admin = new Client({ ...base, database: 'postgres' })
await admin.connect()
await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`)
await admin.query(`CREATE DATABASE ${DB}`)
await admin.end()
const pool = new Pool({ ...base, database: DB, max: 3 })
pool.on('error', (e) => console.log('pool error:', e.message))

let pass = 0, fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`) }
}
const { typeDdl, tableDdl } = await import('../server/dist/catalog/ddl.js')
const oidOfType = async (n) => (await pool.query(`SELECT oid::text o FROM pg_type WHERE typname=$1`, [n])).rows[0]?.o
const oidOfRel = async (n) => (await pool.query(`SELECT $1::regclass::oid::text o`, [`public.${n}`])).rows[0]?.o

// helper: create -> generate -> drop -> re-apply -> compare a fingerprint
async function roundTrip(label, createSql, kind, name, dropSql, fingerprintSql, params) {
  try { await pool.query(createSql) }
  catch (e) { fail++; console.log(`  FAIL ${label} — fixture: ${e.message} [${e.code}]`); return }
  const before = (await pool.query(fingerprintSql, params)).rows
  const oid = kind === 'type' ? await oidOfType(name) : await oidOfRel(name)
  const ddl = kind === 'type'
    ? await typeDdl(pool, oid, 'public', name)
    : await tableDdl(pool, oid, 'public', name)
  await pool.query(dropSql)
  try { await pool.query(ddl) }
  catch (e) {
    fail++; console.log(`  FAIL ${label} — DDL did not apply: ${e.message} [${e.code}]`)
    console.log(ddl.split('\n').map((l) => '       ' + l).join('\n'))
    return
  }
  const after = (await pool.query(fingerprintSql, params)).rows
  if (JSON.stringify(before) === JSON.stringify(after)) { pass++; console.log(`  ok   ${label}`) }
  else {
    fail++; console.log(`  FAIL ${label} — fingerprint differs`)
    console.log('       before: ' + JSON.stringify(before))
    console.log('       after:  ' + JSON.stringify(after))
    console.log(ddl.split('\n').map((l) => '       ' + l).join('\n'))
  }
}

console.log('== range types ==')
await roundTrip('plain range (fidelity)',
  `CREATE TYPE r1 AS RANGE (subtype = float8)`, 'type', 'r1',
  'DROP TYPE r1 CASCADE',
  `SELECT r.rngsubtype::regtype::text AS subtype,
          (SELECT ocn.nspname||'.'||oc.opcname FROM pg_opclass oc
             JOIN pg_namespace ocn ON ocn.oid=oc.opcnamespace WHERE oc.oid=r.rngsubopc) AS opc,
          NULLIF(r.rngcollation,0)::regcollation::text AS coll,
          NULLIF(r.rngcanonical,0)::regproc::text AS canon,
          NULLIF(r.rngsubdiff,0)::regproc::text AS diff
   FROM pg_range r JOIN pg_type t ON t.oid=r.rngtypid WHERE t.typname=$1`, ['r1'])

await roundTrip('range with explicit multirange name',
  `CREATE TYPE r2 AS RANGE (subtype = float8, multirange_type_name = mr2)`, 'type', 'r2',
  'DROP TYPE r2 CASCADE',
  `SELECT (SELECT typname FROM pg_type WHERE oid = (SELECT rngmultitypid FROM pg_range rg
             JOIN pg_type t ON t.oid=rg.rngtypid WHERE t.typname=$1)) AS multirange`, ['r2'])

await roundTrip('range with explicit collation',
  `CREATE TYPE r3 AS RANGE (subtype = text, collation = pg_catalog."C")`, 'type', 'r3',
  'DROP TYPE r3 CASCADE',
  `SELECT NULLIF(r.rngcollation,0)::regcollation::text AS coll
   FROM pg_range r JOIN pg_type t ON t.oid=r.rngtypid WHERE t.typname=$1`, ['r3'])

console.log('\n== composite type with COLLATE ==')
await roundTrip('composite attribute collation',
  `CREATE TYPE c1 AS (a integer, b text COLLATE pg_catalog."C", d numeric(8,2))`, 'type', 'c1',
  'DROP TYPE c1 CASCADE',
  `SELECT a.attname, format_type(a.atttypid,a.atttypmod) AS type,
          NULLIF(a.attcollation,0)::regcollation::text AS coll
   FROM pg_attribute a JOIN pg_type t ON t.oid=a.attrelid
   WHERE t.typname=$1 AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`, ['c1'])

console.log('\n== domain with a named constraint ==')
await roundTrip('domain constraint name',
  `CREATE DOMAIN d1 AS integer DEFAULT 3 NOT NULL CONSTRAINT pos CHECK (VALUE > 0)`, 'type', 'd1',
  'DROP DOMAIN d1 CASCADE',
  `SELECT c.conname, pg_get_constraintdef(c.oid) AS def FROM pg_constraint c
   JOIN pg_type t ON t.oid=c.contypid WHERE t.typname=$1`, ['d1'])

console.log('\n== sub-partitioned child ==')
{
  await pool.query(`CREATE TABLE sp (a int NOT NULL, b int NOT NULL, PRIMARY KEY (a,b)) PARTITION BY RANGE (a)`)
  await pool.query(`CREATE TABLE sp_c PARTITION OF sp FOR VALUES FROM (0) TO (100) PARTITION BY HASH (b)`)
  await pool.query(`CREATE TABLE sp_c_0 PARTITION OF sp_c FOR VALUES WITH (MODULUS 2, REMAINDER 0)`)
  const fp = `SELECT c.relkind, c.relispartition,
      (SELECT pg_get_partkeydef(p.partrelid) FROM pg_partitioned_table p WHERE p.partrelid=c.oid) AS partkey,
      pg_get_expr(c.relpartbound, c.oid) AS bound
    FROM pg_class c WHERE c.relname=$1`
  const before = (await pool.query(fp, ['sp_c'])).rows
  const oid = await oidOfRel('sp_c')
  const ddl = await tableDdl(pool, oid, 'public', 'sp_c')
  console.log(ddl.split('\n').map((l) => '       ' + l).join('\n'))
  ok('sub-partitioned child emits its own PARTITION BY', /PARTITION BY HASH \(b\)/.test(ddl))
  // rebuild: drop the whole tree, recreate the parent, apply the child DDL
  await pool.query('DROP TABLE sp CASCADE')
  await pool.query(`CREATE TABLE sp (a int NOT NULL, b int NOT NULL, PRIMARY KEY (a,b)) PARTITION BY RANGE (a)`)
  let applied = true, err = ''
  try { await pool.query(ddl) } catch (e) { applied = false; err = `${e.message} [${e.code}]` }
  ok('sub-partitioned child DDL applies', applied, err)
  if (applied) {
    const after = (await pool.query(fp, ['sp_c'])).rows
    ok('sub-partitioned child fingerprint matches', JSON.stringify(before) === JSON.stringify(after),
      `before ${JSON.stringify(before)} after ${JSON.stringify(after)}`)
    // and its own child can now be attached
    let grandOk = true, grandErr = ''
    try { await pool.query(`CREATE TABLE sp_c_0 PARTITION OF sp_c FOR VALUES WITH (MODULUS 2, REMAINDER 0)`) }
    catch (e) { grandOk = false; grandErr = `${e.message} [${e.code}]` }
    ok('grandchild partition can attach', grandOk, grandErr)
  }
}

// ------------------------------------------------------------------ teardown
const cleanup = async () => {
  await pool.end().catch(() => {})
  const adm = new Client({ ...base, database: 'postgres' })
  await adm.connect()
  await adm.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`)
  const left = await adm.query(`SELECT datname FROM pg_database WHERE datname LIKE 'pgdev_%'`)
  await adm.end()
  return left.rows.map((r) => r.datname)
}
process.on('uncaughtException', async (e) => {
  console.log('unexpected error:', e.message)
  console.log('leftover pgdev_% databases:', JSON.stringify(await cleanup().catch(() => ['cleanup failed'])))
  process.exit(2)
})
const left = await cleanup()
console.log(`\nleftover pgdev_% databases: ${JSON.stringify(left)}`)
console.log(`\n===== ${pass} passed, ${fail} failed =====`)
process.exit(fail ? 1 : 0)
