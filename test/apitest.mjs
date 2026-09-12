// End-to-end API test: a real Fastify server, a real pg.Pool, and fixtures
// created inside a database this harness owns. Exercises the documented HTTP
// surface exactly as the browser does.
import Fastify from 'fastify'
import { createRequire } from 'node:module'
const require = createRequire(new URL('../server/', import.meta.url))
const { Client, Pool } = require('pg')

// Credentials come from PGDEV_TEST_URL (e.g. postgres://user:pass@host:5432/postgres)
// or, failing that, from a JSON object on stdin. Nothing is hard-coded.
const chunks = []
for await (const c of process.stdin) chunks.push(c)
const stdinText = Buffer.concat(chunks).toString('utf8').trim()
const base = stdinText
  ? JSON.parse(stdinText)
  : (() => {
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
    })()

const DB = 'pgdev_apitest'

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
process.env.PORT = '3211'
const { connectionRoutes } = await import('../server/dist/routes/connections.js')
const { metadataRoutes } = await import('../server/dist/routes/metadata.js')
const { ddlRoutes } = await import('../server/dist/routes/ddl.js')
const { queryRoutes } = await import('../server/dist/routes/query.js')

const app = Fastify({ bodyLimit: 4 * 1024 * 1024 })
app.setErrorHandler((err, _req, reply) => reply.code(err.statusCode ?? 500).send({ error: err.message }))
// same origin guard as index.ts
app.addHook('onRequest', async (req, reply) => {
  if (!req.url.startsWith('/api/')) return
  if (!req.headers.origin && req.headers['sec-fetch-site'] === 'same-origin') return
  if (!req.headers.origin) return reply.code(403).send({ error: 'Origin required' })
  return
})
await app.register(connectionRoutes)
await app.register(metadataRoutes)
await app.register(ddlRoutes)
await app.register(queryRoutes)

const ORIGIN = 'http://127.0.0.1:3211'
const call = async (method, url, payload) => {
  const res = await app.inject({ method, url, payload, headers: { origin: ORIGIN } })
  let body = null
  try { body = res.json() } catch { body = res.body }
  return { status: res.statusCode, body }
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
process.on('uncaughtException', async (e) => {
  console.log('unexpected error:', e.message)
  console.log('leftover:', JSON.stringify(await cleanup().catch(() => ['cleanup failed'])))
  process.exit(2)
})
const left = await cleanup()
console.log(`\nleftover pgdev_% databases: ${JSON.stringify(left)}`)
console.log(`\n===== ${pass} passed, ${fail} failed =====`)
process.exit(fail ? 1 : 0)
