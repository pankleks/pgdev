// Aggregate DDL round-trip, run entirely inside a database this harness owns.
// Creates each aggregate, generates DDL, drops it, re-executes the generated
// text verbatim, and compares the pg_aggregate fingerprint before/after.

// Credentials: PGDEV_TEST_URL from the environment or the repo .env.
import { credentials, Client, Pool } from './lib/db.mjs'
const base = await credentials()

const DB = 'pgdev_aggtest'

// ---- scratch database lifecycle (only ever touches DB) ----------------------
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

const { functionDdl } = await import('../server/dist/catalog/ddl.js')

const FINGERPRINT = `SELECT p.proname, a.aggkind, a.aggtransfn::regproc::text AS sfunc,
    format_type(a.aggtranstype, NULL) AS stype, a.aggtransspace, a.aggfinalextra, a.aggfinalmodify,
    NULLIF(a.aggfinalfn::regproc::text,'-') AS finalfn,
    NULLIF(a.aggcombinefn::regproc::text,'-') AS combinefn,
    a.agginitval, NULLIF(a.aggmtransfn::regproc::text,'-') AS msfunc,
    NULLIF(a.aggminvtransfn::regproc::text,'-') AS minvfunc,
    CASE WHEN a.aggmtranstype <> 0 THEN format_type(a.aggmtranstype, NULL) END AS mstype,
    a.aggmtransspace, NULLIF(a.aggmfinalfn::regproc::text,'-') AS mfinalfn,
    a.aggmfinalextra, a.aggmfinalmodify, a.aggminitval,
    NULLIF(a.aggsortop,0)::regoper::text AS sortop, p.proparallel
  FROM pg_aggregate a JOIN pg_proc p ON p.oid = a.aggfnoid WHERE p.proname = $1`

const fingerprint = async (name) => (await pool.query(FINGERPRINT, [name])).rows[0]
const oidOf = async (name) =>
  (await pool.query(`SELECT p.oid::text AS o FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname=$1 AND p.prokind='a'`, [name])).rows[0]?.o

async function roundTrip(label, createSql, name, dropSql) {
  try {
    await pool.query(createSql)
  } catch (e) {
    fail++; console.log(`  FAIL ${label} — could not create the fixture: ${e.message} [${e.code}]`)
    return
  }
  const before = await fingerprint(name)
  const oid = await oidOf(name)
  const ddl = await functionDdl(pool, oid, 'public', name)
  await pool.query(dropSql)
  let applied = true, err = ''
  try { await pool.query(ddl) } catch (e) { applied = false; err = `${e.message} [${e.code}]` }
  if (!applied) {
    fail++; console.log(`  FAIL ${label} — generated DDL did not apply: ${err}`)
    console.log(ddl.split('\n').map((l) => '       ' + l).join('\n'))
    return
  }
  const after = await fingerprint(name)
  const same = JSON.stringify(before) === JSON.stringify(after)
  if (same) { pass++; console.log(`  ok   ${label}`) }
  else {
    fail++
    console.log(`  FAIL ${label} — fingerprint differs`)
    for (const k of Object.keys(before)) {
      if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) {
        console.log(`       ${k}: was ${JSON.stringify(before[k])} now ${JSON.stringify(after[k])}`)
      }
    }
    console.log(ddl.split('\n').map((l) => '       ' + l).join('\n'))
  }
}

console.log('== aggregates ==')
await roundTrip('plain aggregate',
  `CREATE AGGREGATE a1(integer) (SFUNC=int4pl, STYPE=integer, INITCOND='0')`, 'a1',
  'DROP AGGREGATE a1(integer)')

await roundTrip('SORTOP + PARALLEL SAFE',
  `CREATE AGGREGATE a2(integer) (SFUNC=int4larger, STYPE=integer,
     SORTOP = OPERATOR(pg_catalog.>), PARALLEL = SAFE)`, 'a2',
  'DROP AGGREGATE a2(integer)')

// FINALFUNC_EXTRA needs a finalfn over 'internal', which cannot be declared by
// a user function, so the built-in array_agg/sum/avg cases below cover it.

await roundTrip('moving aggregate (MSFUNC/MINVFUNC/MSTYPE)',
  `CREATE AGGREGATE a4(integer) (SFUNC=int4pl, STYPE=integer, INITCOND='0',
     MSFUNC=int4pl, MINVFUNC=int4mi, MSTYPE=integer, MINITCOND='0', PARALLEL=SAFE)`, 'a4',
  'DROP AGGREGATE a4(integer)')

await roundTrip('ordered-set aggregate (percentile_disc shape)',
  `CREATE AGGREGATE a5(float8 ORDER BY float8) (SFUNC=ordered_set_transition, STYPE=internal,
     FINALFUNC=percentile_disc_final, FINALFUNC_EXTRA)`, 'a5',
  'DROP AGGREGATE a5(float8 ORDER BY float8)')

await roundTrip('hypothetical-set aggregate',
  `CREATE AGGREGATE a6(integer ORDER BY integer) (SFUNC=int4pl, STYPE=integer,
     FINALFUNC=int4pl, INITCOND='0', HYPOTHETICAL)`, 'a6',
  'DROP AGGREGATE a6(integer ORDER BY integer)')

await roundTrip('SSPACE',
  `CREATE AGGREGATE a7(integer) (SFUNC=int4pl, STYPE=integer, SSPACE=64, INITCOND='0')`, 'a7',
  'DROP AGGREGATE a7(integer)')

console.log('\n== built-in aggregates that must now be executable ==')
for (const [name, args] of [['array_agg', 'anyarray'], ['sum', 'integer'], ['avg', 'bigint'], ['max', 'integer']]) {
  const r = await pool.query(
    `SELECT p.oid::text AS o, pg_get_function_identity_arguments(p.oid) AS args
     FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='pg_catalog' AND p.proname=$1 AND p.prokind='a' AND p.prokind='a'
       AND format_type(p.proargtypes[0], NULL) = $2`, [name, args])
  if (!r.rows[0]) { ok(`${name}(${args}) present`, false, 'not found in pg_catalog'); continue }
  const ddl = await functionDdl(pool, r.rows[0].o, 'pg_catalog', name)
  // Execute it under a new name in a scratch schema to prove it parses & binds.
  const renamed = ddl.replace(/CREATE AGGREGATE "pg_catalog"\."\w+"/, `CREATE AGGREGATE "public"."zz_${name}"`)
  try {
    await pool.query(renamed)
    ok(`${name}(${args}) DDL executes`, true)
    await pool.query(`DROP AGGREGATE "public"."zz_${name}"(${args})`).catch(() => {})
  } catch (e) {
    ok(`${name}(${args}) DDL executes`, false, `${e.message} [${e.code}]`)
  }
}

// ---- teardown ---------------------------------------------------------------
await pool.end()
const admin2 = new Client({ ...base, database: 'postgres' })
await admin2.connect()
await admin2.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`)
const left = await admin2.query(`SELECT datname FROM pg_database WHERE datname LIKE 'pgdev_%'`)
await admin2.end()
console.log(`\nleftover pgdev_% databases: ${JSON.stringify(left.rows.map((r) => r.datname))}`)
console.log(`\n===== ${pass} passed, ${fail} failed =====`)
process.exit(fail ? 1 : 0)
