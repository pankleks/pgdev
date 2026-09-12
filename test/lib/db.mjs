// Shared plumbing for the live-database suites: credential resolution, the
// scratch-database lifecycle, assertions, and the DDL round-trip helper.
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
const require = createRequire(new URL('../../server/', import.meta.url))
const { Client, Pool } = require('pg')

// Re-exported so suites do not each need their own createRequire shim.
export { Client, Pool }

/**
 * Credentials from PGDEV_TEST_URL, or a JSON object piped on stdin.
 *
 * Stdin is only consulted when it is not a terminal: reading a TTY would hang,
 * and when several suites are run from one parent they share stdin, so the
 * first reader would consume it and the rest would block.
 */
export async function credentials() {
  // Loaded here rather than in the runner so a single suite can be run
  // directly (`node test/aggtest.mjs`) and still find the credentials.
  try {
    process.loadEnvFile(fileURLToPath(new URL('../../.env', import.meta.url)))
  } catch {
    // no .env: fall through to the environment, then to the notice below
  }
  let stdinText = ''
  if (!process.stdin.isTTY) {
    const chunks = []
    for await (const c of process.stdin) chunks.push(c)
    stdinText = Buffer.concat(chunks).toString('utf8').trim()
  }
  if (stdinText) return JSON.parse(stdinText)
  const raw = process.env.PGDEV_TEST_URL
  if (!raw) {
    console.error('PGDEV_TEST_URL is not set.')
    console.error('Point it at a PostgreSQL server the tests may create databases on, e.g.:')
    console.error('  PGDEV_TEST_URL=postgres://user:pass@host:5432/postgres npm test')
    console.error('These tests CREATE and DROP their own pgdev_* databases; never aim them at a database you care about.')
    process.exit(2)
  }
  const u = new URL(raw)
  return {
    host: u.hostname,
    port: Number(u.port || 5432),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    ssl: false,
  }
}

/**
 * Create a scratch database, hand back a Pool plus a teardown that always runs
 * — including on an unexpected throw, so a failing case cannot strand it.
 */
export async function scratchDatabase(base, name) {
  const admin = new Client({ ...base, database: 'postgres' })
  await admin.connect()
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
  await admin.query(`CREATE DATABASE ${name}`)
  await admin.end()

  const pool = new Pool({ ...base, database: name, max: 3 })
  pool.on('error', (e) => console.log(`  [pool error] ${e.message}`))

  const teardown = async () => {
    await pool.end().catch(() => {})
    const adm = new Client({ ...base, database: 'postgres' })
    await adm.connect()
    await adm.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
    const left = await adm.query(`SELECT datname FROM pg_database WHERE datname LIKE 'pgdev_%'`)
    await adm.end()
    return left.rows.map((r) => r.datname)
  }
  process.on('uncaughtException', async (e) => {
    console.log('unexpected error:', e.message)
    console.log('leftover pgdev_% databases:', JSON.stringify(await teardown().catch(() => ['cleanup failed'])))
    process.exit(2)
  })
  return { pool, teardown }
}

export function counters() {
  const state = { pass: 0, fail: 0, failures: [] }
  const eq = (name, got, want) => {
    if (JSON.stringify(got) === JSON.stringify(want)) {
      state.pass++
      console.log(`  ok   ${name}`)
    } else {
      state.fail++
      state.failures.push(name)
      console.log(`  FAIL ${name}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`)
    }
  }
  const ok = (name, cond, detail = '') => eq(name + (detail ? ` — ${detail}` : ''), !!cond, true)
  const report = (label = '') => {
    if (label) console.log(`\n${label}`)
    console.log(`\n===== ${state.pass} passed, ${state.fail} failed =====`)
    return state.fail === 0
  }
  return { state, eq, ok, report }
}

/**
 * Create an object, generate its DDL, drop it, re-execute the generated text
 * verbatim, then compare a catalog fingerprint taken before and after. A text
 * comparison would accept a script that is plausible but not faithful.
 */
export async function roundTrip({ pool, ddl, label, create, drop, fingerprint, params, eq, ok }) {
  try {
    const statements = Array.isArray(create) ? create : [create]
    for (const sql of statements) await pool.query(sql)
  } catch (e) {
    eq(`${label} — fixture applies`, `${e.message} [${e.code}]`, 'no error')
    return
  }
  const before = (await pool.query(fingerprint, params)).rows
  let text
  try {
    text = await ddl()
  } catch (e) {
    eq(`${label} — DDL generates`, `${e.message} [${e.code}]`, 'no error')
    return
  }
  await pool.query(drop)
  try {
    await pool.query(text)
  } catch (e) {
    eq(`${label} — generated DDL applies`, `${e.message} [${e.code}]`, 'no error')
    console.log(text.split('\n').map((l) => '       ' + l).join('\n'))
    return
  }
  const after = (await pool.query(fingerprint, params)).rows
  if (JSON.stringify(before) === JSON.stringify(after)) {
    ok(`${label} — round-trips faithfully`, true)
  } else {
      eq(`${label} — fingerprint matches`, after, before)
      console.log('       before: ' + JSON.stringify(before))
      console.log('       after:  ' + JSON.stringify(after))
      console.log(text.split('\n').map((l) => '       ' + l).join('\n'))
  }
}
