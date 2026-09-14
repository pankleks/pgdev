// End-to-end API test: a real Fastify server, a real pg.Pool, and fixtures
// created inside a database this harness owns. Exercises the documented HTTP
// surface exactly as the browser does.

// Credentials: PGDEV_TEST_URL from the environment or the repo .env.
import { credentials, Client, Pool } from './lib/db.mjs'
const base = await credentials()

// The PID suffix lets two runs (or two CI jobs) share one server without
// DROP ... WITH (FORCE) destroying each other's database.
const DB = `pgdev_apitest_${process.pid}`

// Registered before anything can throw, so a crash cannot strand the scratch
// database (node exits on unhandled rejections without running late handlers).
process.on('uncaughtException', async (e) => {
  console.log('unexpected error:', e.message)
  try {
    const adm = new Client({ ...base, database: 'postgres' })
    await adm.connect()
    await adm.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`)
    await adm.end()
  } catch { /* best effort */ }
  process.exit(2)
})

// ------------------------------------------------------------------ fixtures
const FIXTURE = `
CREATE TABLE departments (
  id serial PRIMARY KEY,
  name text NOT NULL UNIQUE,
  location text
);
CREATE TABLE employees (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  department_id integer NOT NULL REFERENCES departments(id),
  first_name text NOT NULL,
  last_name text NOT NULL,
  email text UNIQUE,
  salary numeric(10,2),
  total numeric(12,2) GENERATED ALWAYS AS (salary * 2) STORED,
  hired_at date DEFAULT current_date
);
CREATE INDEX idx_emp_dept ON employees(department_id);
CREATE UNIQUE INDEX idx_emp_email ON employees(lower(email));
CREATE VIEW v_emp AS SELECT e.id, e.first_name, d.name AS department
  FROM employees e JOIN departments d ON d.id = e.department_id;
CREATE MATERIALIZED VIEW mv_dept AS SELECT department_id, count(*) AS n FROM employees GROUP BY department_id;
CREATE TYPE mood AS ENUM ('sad','ok','happy');
CREATE DOMAIN positive_int AS integer NOT NULL DEFAULT 1 CHECK (VALUE > 0);
CREATE TYPE floatrange AS RANGE (subtype = float8);
CREATE AGGREGATE sum_sq(integer) (SFUNC = int4pl, STYPE = integer, INITCOND = '0', PARALLEL = SAFE);
CREATE FUNCTION dept_count(p_name text) RETURNS integer LANGUAGE sql STABLE AS $$
  SELECT count(*)::int FROM employees e JOIN departments d ON d.id = e.department_id WHERE d.name = p_name
$$;
CREATE FUNCTION trg_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.first_name := initcap(NEW.first_name); RETURN NEW; END $$;
CREATE TRIGGER trg_emp BEFORE INSERT ON employees FOR EACH ROW EXECUTE FUNCTION trg_fn();
ALTER TABLE employees ENABLE ROW LEVEL SECURITY;
CREATE TABLE big (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, label text);
INSERT INTO big (label) SELECT 'row' || g FROM generate_series(1, 2500) g;
INSERT INTO departments (name, location) VALUES ('Engineering','Berlin'),('Sales','London'),('HR','Remote');
INSERT INTO employees (department_id, first_name, last_name, email, salary) VALUES
  (1,'ada','Lovelace','ada@example.com',8500.00),
  (1,'alan','Turing','alan@example.com',9000.00),
  (2,'grace','Hopper','grace@example.com',8200.00);
ANALYZE;
`

const admin = new Client({ ...base, database: 'postgres' })
await admin.connect()
await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`)
await admin.query(`CREATE DATABASE ${DB}`)
await admin.end()
const setup = new Client({ ...base, database: DB })
await setup.connect()
await setup.query(FIXTURE)
await setup.end()

let pass = 0, fail = 0
const eq = (name, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`) }
}
const ok = (name, cond, detail = '') => eq(name + (detail ? ` — ${detail}` : ''), !!cond, true)

// ------------------------------------------------------------------ the server
// The real application, so the origin guard and route wiring under test are
// the ones that ship rather than a copy of them.
const { createApp } = await import('../server/dist/app.js')
const app = await createApp({ serveStatic: false })

const ORIGIN = 'http://localhost'
const call = async (method, url, payload) => {
  const res = await app.inject({ method, url, payload, headers: { origin: ORIGIN } })
  let body = null
  try { body = res.json() } catch { body = res.body }
  return { status: res.statusCode, body }
}

console.log('\n== origin guard (the real one, from createApp) ==')
{
  const bare = await app.inject({ method: 'GET', url: '/api/connections/x/schema' })
  eq('no Origin and no Sec-Fetch-Site is rejected', bare.statusCode, 403)
  const sameSite = await app.inject({
    method: 'GET', url: '/api/connections/x/schema',
    headers: { 'sec-fetch-site': 'same-origin' },
  })
  eq('same-origin GET without Origin is allowed', sameSite.statusCode, 404)
  const evil = await app.inject({
    method: 'GET', url: '/api/connections/x/schema',
    headers: { origin: 'http://evil.example' },
  })
  eq('cross-origin is rejected', evil.statusCode, 403)
  const wrongPort = await app.inject({
    method: 'GET', url: '/api/connections/x/schema',
    headers: { origin: 'http://127.0.0.1:9999' },
  })
  eq('wrong port is rejected', wrongPort.statusCode, 403)
  const good = await app.inject({
    method: 'GET', url: '/api/connections/x/schema',
    headers: { origin: 'http://localhost' },
  })
  eq('matching origin passes the guard', good.statusCode, 404)

  // Browsers and the launcher pick between loopback spellings inconsistently;
  // http://localhost:3000 must work even when the request host is 127.0.0.1.
  const crossLoopback = await app.inject({
    method: 'GET', url: '/api/connections/x/schema',
    headers: { origin: 'http://localhost' },
  })
  eq('localhost origin with a loopback request host is allowed', crossLoopback.statusCode, 404)
  const ipv6 = await app.inject({
    method: 'GET', url: '/api/connections/x/schema',
    headers: { origin: 'http://[::1]' },
  })
  eq('IPv6 loopback origin is allowed', ipv6.statusCode, 404)
  const remote = await app.inject({
    method: 'GET', url: '/api/connections/x/schema',
    headers: { origin: 'http://192.168.70.70' },
  })
  eq('a non-loopback origin is still rejected', remote.statusCode, 403)
  const badScheme = await app.inject({
    method: 'GET', url: '/api/connections/x/schema',
    headers: { origin: 'https://localhost' },
  })
  eq('a scheme mismatch is still rejected', badScheme.statusCode, 403)
}

console.log('== connect ==')
const conn = await call('POST', '/api/connections', {
  host: base.host, port: base.port, database: DB, user: base.user, password: base.password, ssl: false,
})
eq('connection opens', conn.status, 200)
const id = conn.body.id
ok('connection id returned', typeof id === 'string' && id.length > 10, id)
if (!id) { console.log('cannot continue'); process.exit(1) }

console.log('\n== GET /schema ==')
const schema = await call('GET', `/api/connections/${id}/schema`)
eq('schema status', schema.status, 200)
const names = {
  tables: schema.body.tables.map((t) => t.name).sort(),
  views: schema.body.views.map((v) => v.name).sort(),
  functions: schema.body.functions.map((f) => f.name).sort(),
  types: schema.body.types.map((t) => t.name).sort(),
}
eq('tables harvested', names.tables, ['big', 'departments', 'employees'])
eq('views harvested', names.views, ['mv_dept', 'v_emp'])
eq('matview flagged', schema.body.views.find((v) => v.name === 'mv_dept').materialized, true)
ok('aggregate harvested as such', schema.body.functions.some((f) => f.name === 'sum_sq' && f.kind === 'aggregate'),
  JSON.stringify(schema.body.functions.filter((f) => f.name === 'sum_sq').map((f) => f.kind)))
ok('trigger function flagged', schema.body.functions.some((f) => f.kind === 'trigger'),
  JSON.stringify(schema.body.functions.filter((f) => f.kind === 'trigger').map((f) => f.name)))
eq('types harvested', names.types, ['floatrange', 'mood', 'positive_int'])
const emp = schema.body.tables.find((t) => t.name === 'employees')
eq('identity column surfaced', emp.columns.find((c) => c.name === 'id').type, 'bigint')
eq('generated column surfaced', emp.columns.find((c) => c.name === 'total').type, 'numeric(12,2)')
ok('indexes attached', emp.indexes.length >= 3, `${emp.indexes.length}`)
ok('constraints attached', emp.constraints.some((c) => c.type === 'f'), JSON.stringify(emp.constraints.map((c) => c.type)))
ok('trigger attached', emp.triggers.length === 1, JSON.stringify(emp.triggers.map((t) => t.name)))

console.log('\n== GET /ddl for every object type ==')
const ddlOf = async (type, name, extra = {}) => {
  const qs = new URLSearchParams({ type, schema: 'public', name, ...extra }).toString()
  return call('GET', `/api/connections/${id}/ddl?${qs}`)
}
const t = await ddlOf('table', 'employees', { oid: emp.oid })
eq('table ddl status', t.status, 200)
ok('table ddl has identity', /GENERATED ALWAYS AS IDENTITY/.test(t.body.ddl))
ok('table ddl has generated column', /GENERATED ALWAYS AS \(\(salary \* 2\)\) STORED|GENERATED ALWAYS AS/.test(t.body.ddl))
ok('table ddl quotes identifiers', /"public"\."employees"/.test(t.body.ddl))
const fkLines = (t.body.ddl || '').split('\n').filter((l) => /FOREIGN KEY/.test(l))
ok('table ddl has FK to departments', fkLines.length > 0 && /departments/.test(fkLines.join(' ')),
  `fk lines: ${JSON.stringify(fkLines)}`)
ok('table ddl has the unique constraint', /UNIQUE/.test(t.body.ddl), (t.body.ddl || '').split('\n').filter((l) => /UNIQUE/.test(l)).join(' | '))

for (const [type, name, extra, expect] of [
  ['view', 'v_emp', { oid: schema.body.views.find((v) => v.name === 'v_emp').oid }, /CREATE OR REPLACE VIEW/],
  ['view', 'mv_dept', { oid: schema.body.views.find((v) => v.name === 'mv_dept').oid }, /CREATE MATERIALIZED VIEW/],
  ['function', 'dept_count', { oid: schema.body.functions.find((f) => f.name === 'dept_count').oid }, /CREATE OR REPLACE FUNCTION/],
  ['function', 'sum_sq', { oid: schema.body.functions.find((f) => f.name === 'sum_sq').oid }, /CREATE AGGREGATE/],
  ['type', 'mood', { oid: schema.body.types.find((x) => x.name === 'mood').oid }, /AS ENUM/],
  ['type', 'positive_int', { oid: schema.body.types.find((x) => x.name === 'positive_int').oid }, /CREATE DOMAIN/],
  ['type', 'floatrange', { oid: schema.body.types.find((x) => x.name === 'floatrange').oid }, /AS RANGE/],
  ['index', 'idx_emp_dept', {}, /CREATE INDEX/],
  ['trigger', 'trg_emp', { parent: 'employees' }, /CREATE TRIGGER/],
  ['constraint', emp.constraints.find((c) => c.type === 'f').name, { parent: 'employees' }, /ADD CONSTRAINT/],
]) {
  const r = await ddlOf(type, name, extra)
  const hit = r.status === 200 && expect.test(r.body.ddl || '')
  ok(`${type} ${name}`, hit, r.status !== 200 ? `status ${r.status} ${r.body.error}` : 'unexpected text')
}
const bad = await ddlOf('nope', 'x')
eq('unknown ddl type rejected', bad.status, 400)

console.log('\n== POST /query ==')
const q = (sql, tabKey, maxRows) =>
  call('POST', `/api/connections/${id}/query`,
    { sql, tabKey, ...(maxRows === undefined ? {} : { maxRows }) })

const sel = await q('SELECT * FROM departments ORDER BY id', 'tab1')
eq('select status', sel.status, 200)
eq('three rows', sel.body.results[0].rowCount, 3)
eq('not truncated', sel.body.results[0].truncated, false)
eq('columns', sel.body.results[0].columns, ['id', 'name', 'location'])
eq('column types resolved', sel.body.results[0].columnTypes, ['integer', 'text', 'text'])
ok('duration reported', typeof sel.body.durationMs === 'number')

const multi = await q('SELECT 1 AS a; SELECT 2 AS b; SELECT 3 AS c;', 'tab2')
eq('multi-statement count', multi.body.results.length, 3)
eq('all results are data', multi.body.results.map((r) => r.kind), ['data', 'data', 'data'])

const cmd = await q("INSERT INTO departments (name, location) VALUES ('QA','Nowhere')", 'tab3')
eq('command result kind', cmd.body.results[0].kind, 'command')
eq('command rowCount', cmd.body.results[0].rowCount, 1)

const trig = await q("SELECT first_name FROM employees WHERE email='ada@example.com'", 'tab4')
eq('row inserted before the trigger existed keeps its case', trig.body.results[0].rows[0][0], 'Ada')
const ins = await q("INSERT INTO employees (department_id, first_name, last_name, email, salary) VALUES (1,'bob','New','bob@example.com',1000)", 'tab5')
eq('insert with trigger ok', ins.status, 200)
const cap = await q("SELECT first_name FROM employees WHERE email='bob@example.com'", 'tab6')
eq('trigger fired (initcap)', cap.body.results[0].rows[0][0], 'Bob')

// JSON/JSONB travel as raw server text: big integers, number spellings and
// string scalars survive, and JSON null is distinguishable from SQL NULL.
// The first batch runs through the cursor path (single SELECT), the second
// through the bounded direct path (the final statement is not the only one).
const jsonSel = await q(
  `SELECT '{"big": 9007199254740993, "small": 1.0}'::jsonb AS j, '"abc"'::jsonb AS s, 'null'::jsonb AS n, NULL::jsonb AS z`,
  'tab7',
)
{
  const row = jsonSel.body.results[0].rows[0]
  ok('large JSON integers survive the round trip', row[0].includes('9007199254740993'), row[0])
  ok('number spellings survive the round trip', row[0].includes('1.0'), row[0])
  eq('JSON string scalars keep their quotes', row[1], '"abc"')
  eq('JSON null is not SQL NULL', row[2], 'null')
  eq('SQL NULL stays null', row[3], null)
}
const jsonDirect = await q(`SELECT '{"big": 9007199254740993}'::jsonb AS j; SELECT 1`, 'tab8')
ok('bounded direct results keep JSON text too',
  jsonDirect.body.results[0].rows[0][0].includes('9007199254740993'),
  jsonDirect.body.results[0].rows[0][0])

console.log('\n== transaction safety ==')
eq('transaction fixture created', (await q('CREATE TABLE tx_check (id integer PRIMARY KEY)', 'tx')).status, 200)
const observer = new Client({ ...base, database: DB })
await observer.connect()
try {
  for (const sql of [
    'BEGIN; INSERT INTO tx_check VALUES (1)',
    'INSERT INTO tx_check VALUES (1); BEGIN',
    'BEGIN; INSERT INTO tx_check VALUES (1); COMMIT; BEGIN',
    'BEGIN; SAVEPOINT s; ROLLBACK TO s',
    'COMMIT AND CHAIN',
  ]) {
    const rejected = await q(sql, 'tx')
    eq(`unfinished batch rejected: ${sql}`, rejected.status, 400)
    ok('rejection explains that nothing ran', /No statements were executed/.test(rejected.body.error))
    eq('rejected batch made no persistent changes', (await observer.query('SELECT count(*)::int AS n FROM tx_check')).rows[0].n, 0)
  }
  eq('complete commit succeeds', (await q('BEGIN; INSERT INTO tx_check VALUES (1); COMMIT', 'tx')).status, 200)
  eq('complete rollback succeeds', (await q('BEGIN; INSERT INTO tx_check VALUES (2); ROLLBACK', 'tx')).status, 200)
  eq('savepoint rollback leaves enclosing transaction tracked', (await q('INSERT INTO tx_check VALUES (3); SAVEPOINT s; INSERT INTO tx_check VALUES (4); ROLLBACK TO SAVEPOINT s', 'tx')).status, 200)
  eq('chained transactions with final rollback succeed', (await q('BEGIN; INSERT INTO tx_check VALUES (5); COMMIT AND CHAIN; INSERT INTO tx_check VALUES (6); ROLLBACK', 'tx')).status, 200)
  eq('independent connection sees only committed rows', (await observer.query('SELECT id FROM tx_check ORDER BY id')).rows.map(r => r.id), [1, 3, 5])
  eq('no transaction leaked into idle pool clients', (await observer.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND application_name = 'pgDEV' AND state LIKE 'idle in transaction%'")).rows[0].n, 0)
} finally {
  await observer.end()
}

console.log('\n== bounded direct results ==')
const earlyLarge = await q('SELECT generate_series(1, 2500) AS n; SELECT 1 AS last', 'bounds', 7)
eq('earlier SELECT is capped', earlyLarge.body.results[0].rows.length, 7)
eq('earlier SELECT reports total rows', earlyLarge.body.results[0].totalRowCount, 2500)
eq('earlier SELECT reports a partial result', earlyLarge.body.results[0].limited, true)
eq('earlier SELECT does not advertise a closed cursor', earlyLarge.body.results[0].truncated, false)
const defaultBound = await q('SELECT generate_series(1, 1001); SELECT 1', 'bounds')
eq('default direct result cap is 500', defaultBound.body.results[0].rows.length, 500)
const exactBound = await q('SELECT generate_series(1, 7); SELECT 1', 'bounds', 7)
eq('exactly the cap is not a partial result', exactBound.body.results[0].limited, false)
const emptyBound = await q('SELECT 1 AS n WHERE false; SELECT 1', 'bounds', 7)
eq('empty direct result retains columns', emptyBound.body.results[0].columns, ['n'])
eq('empty direct result has no rows', emptyBound.body.results[0].rows.length, 0)

eq('bounded mutation fixture created', (await q('CREATE TABLE bounded_check (id integer PRIMARY KEY, changes integer DEFAULT 0)', 'bounds')).status, 200)
const insertedBound = await q('INSERT INTO bounded_check (id) SELECT generate_series(1, 2500) RETURNING id', 'bounds', 7)
eq('INSERT RETURNING rows capped', insertedBound.body.results[0].rows.length, 7)
eq('INSERT RETURNING reports complete row count', insertedBound.body.results[0].totalRowCount, 2500)
eq('INSERT RETURNING marked partial', insertedBound.body.results[0].limited, true)
eq('INSERT RETURNING has no more-pages flag', insertedBound.body.results[0].truncated, false)
const updatedBound = await q('UPDATE bounded_check SET changes = changes + 1 RETURNING id; SELECT id FROM bounded_check ORDER BY id', 'bounds', 7)
eq('UPDATE RETURNING capped in a batch', updatedBound.body.results[0].rows.length, 7)
eq('SELECT in mutation batch capped', updatedBound.body.results[1].rows.length, 7)
eq('SELECT in mutation batch marked partial', updatedBound.body.results[1].limited, true)
const cteBound = await q('WITH changed AS (UPDATE bounded_check SET changes = changes + 1 RETURNING id) SELECT id FROM changed', 'bounds', 7)
eq('data-modifying CTE fallback succeeds', cteBound.status, 200)
eq('data-modifying CTE fallback capped', cteBound.body.results[0].rows.length, 7)
eq('data-modifying CTE fallback marked partial', cteBound.body.results[0].limited, true)
const boundObserver = new Client({ ...base, database: DB })
await boundObserver.connect()
try {
  eq('all mutations committed exactly once', (await boundObserver.query('SELECT count(*)::int AS n, min(changes) AS lo, max(changes) AS hi FROM bounded_check')).rows[0], { n: 2500, lo: 2, hi: 2 })
  const lateError = await q('UPDATE bounded_check SET changes = 99; SELECT 1 / (n - 19) FROM generate_series(1, 20) n; SELECT 1', 'bounds', 7)
  eq('error after the retained rows is surfaced', lateError.status, 400)
  eq('late SQLSTATE preserved', lateError.body.code, '22012')
  eq('late error rolls back mutations', (await boundObserver.query('SELECT max(changes) AS hi FROM bounded_check')).rows[0].hi, 2)
} finally {
  await boundObserver.end()
}
const vacuumBound = await q('VACUUM bounded_check; SELECT generate_series(1, 25)', 'bounds', 7)
eq('autocommit batch succeeds', vacuumBound.status, 200)
eq('autocommit batch SELECT capped', vacuumBound.body.results[1].rows.length, 7)
eq('autocommit batch SELECT marked partial', vacuumBound.body.results[1].limited, true)
const deletedBound = await q('DELETE FROM bounded_check RETURNING id', 'bounds', 7)
eq('DELETE RETURNING capped', deletedBound.body.results[0].rows.length, 7)
eq('DELETE RETURNING total rows', deletedBound.body.results[0].totalRowCount, 2500)
eq('all deletes completed', (await q('SELECT count(*)::int FROM bounded_check', 'bounds')).body.results[0].rows[0][0], 0)

console.log('\n== paging (the P0 fix, end to end) ==')
const p1 = await q('SELECT id, label FROM big ORDER BY id', 'page', 500)
eq('page 1 status', p1.status, 200)
eq('page 1 rows', p1.body.results[0].rowCount, 500)
eq('page 1 truncated', p1.body.results[0].truncated, true)
const seen = [p1.body.results[0].rows]
let trunc = p1.body.results[0].truncated, guard = 0
while (trunc && guard++ < 20) {
  const m = await call('POST', `/api/connections/${id}/query/more`, { tabKey: 'page', maxRows: 500 })
  if (m.status !== 200) { ok(`more #${guard}`, false, `${m.status} ${m.body.error}`); break }
  seen.push(m.body.rows); trunc = m.body.truncated
}
const flat = seen.flat().map((r) => r[0])
eq('all 2500 rows paged', flat.length, 2500)
eq('no duplicates', new Set(flat).size, 2500)
eq('contiguous', flat.every((v, i) => v === i + 1), true)
const after = await call('POST', `/api/connections/${id}/query/close`, { tabKey: 'page' })
eq('session close ok', after.body.ok, true)

const withq = await q('WITH n AS (SELECT g FROM generate_series(1,1200) g) SELECT g FROM n', 'cte', 500)
eq('WITH query is paged (truncated flag)', withq.body.results[0].truncated, true)

console.log('\n== errors and cancellation ==')
const syntax = await q('SELECT * FROM nonexistent_table_xyz', 'err1')
eq('syntax/relation error status', syntax.status, 400)
ok('error message surfaced', /nonexistent_table_xyz/.test(syntax.body.error), syntax.body.error)
ok('SQLSTATE surfaced', /^[0-9A-Z]{5}$/.test(syntax.body.code), String(syntax.body.code))

const timeout = await app.inject({
  method: 'POST', url: `/api/connections/${id}/query`,
  payload: { sql: 'SELECT pg_sleep(35)', tabKey: 'slow' }, headers: { origin: ORIGIN },
})
ok('statement timeout enforced', timeout.statusCode === 400 && /timeout/i.test(timeout.json().error),
  `${timeout.statusCode} ${timeout.json().error}`)

console.log('\n== configurable statement timeout ==')
{
  const short = await call('POST', '/api/connections', {
    host: base.host, port: base.port, database: DB, user: base.user, password: base.password, ssl: false,
    statementTimeout: 1,
  })
  eq('1s-timeout connection opens', short.status, 200)
  const sid = short.body.id
  if (sid) {
    const t0 = Date.now()
    const slept = await app.inject({
      method: 'POST', url: `/api/connections/${sid}/query`,
      payload: { sql: 'SELECT pg_sleep(5)', tabKey: 'slow2' }, headers: { origin: ORIGIN },
    })
    const took = Date.now() - t0
    ok('1s statement timeout enforced', slept.statusCode === 400 && /timeout/i.test(slept.json().error) && took < 4000,
      `${slept.statusCode} after ${took}ms ${slept.json().error}`)
    eq('1s-timeout connection closes', (await call('DELETE', `/api/connections/${sid}`)).status, 200)
  }
  const bad = await call('POST', '/api/connections', {
    host: base.host, port: base.port, database: DB, user: base.user, password: base.password, ssl: false,
    statementTimeout: 99999,
  })
  eq('out-of-range timeout rejected', bad.status, 400)
  ok('rejection explains the range', /1 to 600/.test(bad.body.error), bad.body.error)
}

const slow = app.inject({
  method: 'POST', url: `/api/connections/${id}/query`,
  payload: { sql: 'SELECT pg_sleep(5)', tabKey: 'cancel' }, headers: { origin: ORIGIN },
})
await new Promise((r) => setTimeout(r, 700))
const cancel = await call('POST', `/api/connections/${id}/cancel`, { tabKey: 'cancel' })
eq('cancel acknowledged', cancel.body.ok, true)
const slowRes = await slow
ok('cancelled query reports cancellation', slowRes.statusCode === 400 && /cancel/i.test(slowRes.json().error),
  `${slowRes.statusCode} ${slowRes.json().error}`)

const vac = await q('VACUUM big', 'vac')
eq('VACUUM (autocommit) succeeds', vac.status, 200)
eq('VACUUM reports command', vac.body.results[0].kind, 'command')

const badRows = await q('SELECT 1', 'mr', 0)
eq('maxRows 0 rejected', badRows.status, 400)
const badRows2 = await q('SELECT 1', 'mr', 999999)
eq('maxRows above the cap rejected', badRows2.status, 400)

console.log('\n== DDL execution through the API ==')
const madeTable = await q('CREATE TABLE made_here (a integer PRIMARY KEY, b text)', 'ddl1')
eq('CREATE TABLE via query tool', madeTable.status, 200)
const madeDdl = await ddlOf('table', 'made_here', { oid: (await q("SELECT 'made_here'::regclass::oid::text AS o", 'ddl2')).body.results[0].rows[0][0] })
ok('generated ddl for the new table', madeDdl.status === 200 && /"public"\."made_here"/.test(madeDdl.body.ddl))
const rec = await q('DROP TABLE made_here', 'ddl3')
eq('DROP TABLE via query tool', rec.status, 200)
const reapplied = await q(madeDdl.body.ddl, 'ddl4')
eq('generated DDL re-executes through the API', reapplied.status, 200)

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

console.log('\n== catalog queries survive paged sessions (separate pool) ==')
{
  const extra = await call('POST', '/api/connections', {
    host: base.host, port: base.port, database: DB, user: base.user, password: base.password, ssl: false,
  })
  const pid = extra.body.id
  const qid = (sql, tabKey, maxRows) =>
    call('POST', `/api/connections/${pid}/query`, { sql, tabKey, maxRows })
  // The main pool holds five clients; pin all of them with truncated cursors.
  let pinned = 0
  for (let i = 0; i < 5; i++) {
    const r = await qid('SELECT id FROM big ORDER BY id', `pin${i}`, 50)
    if (r.body?.results?.[0]?.truncated === true) pinned++
  }
  eq('all main-pool clients pinned by sessions', pinned, 5)
  const t0 = Date.now()
  const during = await call('GET', `/api/connections/${pid}/schema`)
  const took = Date.now() - t0
  eq('schema succeeds while sessions pin the main pool', during.status, 200)
  ok('schema did not wait for a main-pool slot', took < 5000, `${took}ms`)
  for (let i = 0; i < 5; i++) await call('POST', `/api/connections/${pid}/query/close`, { tabKey: `pin${i}` })
  eq('paging connection closes', (await call('DELETE', `/api/connections/${pid}`)).status, 200)
}

console.log('\n== disconnect cancels in-flight queries ==')
{
  const extra = await call('POST', '/api/connections', {
    host: base.host, port: base.port, database: DB, user: base.user, password: base.password, ssl: false,
  })
  eq('second connection opens', extra.status, 200)
  const eid = extra.body.id
  const running = app.inject({
    method: 'POST', url: `/api/connections/${eid}/query`,
    payload: { sql: 'SELECT pg_sleep(30)', tabKey: 'disconnect-cancel' }, headers: { origin: ORIGIN },
  })
  await new Promise((r) => setTimeout(r, 700))
  const t0 = Date.now()
  const del2 = await call('DELETE', `/api/connections/${eid}`)
  const took = Date.now() - t0
  eq('disconnect returns promptly', del2.status, 200)
  ok('disconnect did not wait for the statement timeout', took < 5000, `${took}ms`)
  const res = await running
  ok('in-flight query was cancelled', res.statusCode === 400 && /cancel/i.test(res.json().error),
    `${res.statusCode} ${res.json().error}`)
}

console.log('\n== disconnect ==')
const del = await call('DELETE', `/api/connections/${id}`)
eq('connection closes', del.status, 200)
const gone = await call('GET', `/api/connections/${id}/schema`)
eq('closed connection is unknown', gone.status, 404)

// ------------------------------------------------------------------- teardown
const cleanup = async () => {
  await app.close().catch(() => {})
  const adm = new Client({ ...base, database: 'postgres' })
  await adm.connect()
  await adm.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`)
  const left = await adm.query(`SELECT datname FROM pg_database WHERE datname LIKE 'pgdev_%'`)
  await adm.end()
  return left.rows.map((r) => r.datname)
}
const left = await cleanup()
console.log(`\nleftover pgdev_% databases: ${JSON.stringify(left)}`)
console.log(`\n===== ${pass} passed, ${fail} failed =====`)
process.exit(fail ? 1 : 0)
