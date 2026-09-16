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
CREATE SEQUENCE seq_apitest INCREMENT 10 MINVALUE 5 MAXVALUE 500 START 100;
CREATE TYPE mood AS ENUM ('sad','ok','happy');
CREATE DOMAIN positive_int AS integer NOT NULL DEFAULT 1 CHECK (VALUE > 0);
CREATE TYPE floatrange AS RANGE (subtype = float8);
CREATE AGGREGATE sum_sq(integer) (SFUNC = int4pl, STYPE = integer, INITCOND = '0', PARALLEL = SAFE);
CREATE FUNCTION dept_count(p_name text) RETURNS integer LANGUAGE sql STABLE AS $$
  SELECT count(*)::int FROM employees e JOIN departments d ON d.id = e.department_id WHERE d.name = p_name
$$;
COMMENT ON FUNCTION dept_count(text) IS 'Counts employees in a department.';
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
// the ones that ship rather than a copy of them. The agent token file points
// at scratch space: the suite must never read or write the user's real one.
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
const { createApp } = await import('../server/dist/app.js')
const aiTokenFile = join(tmpdir(), `pgdev_aitoken_${process.pid}`)
const app = await createApp({ serveStatic: false, aiTokenFile })

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
  sequences: schema.body.sequences.map((s) => s.name).sort(),
}
eq('tables harvested', names.tables, ['big', 'departments', 'employees'])
eq('views harvested', names.views, ['mv_dept', 'v_emp'])
eq('matview flagged', schema.body.views.find((v) => v.name === 'mv_dept').materialized, true)
ok('aggregate harvested as such', schema.body.functions.some((f) => f.name === 'sum_sq' && f.kind === 'aggregate'),
  JSON.stringify(schema.body.functions.filter((f) => f.name === 'sum_sq').map((f) => f.kind)))
ok('trigger function flagged', schema.body.functions.some((f) => f.kind === 'trigger'),
  JSON.stringify(schema.body.functions.filter((f) => f.kind === 'trigger').map((f) => f.name)))
eq('types harvested', names.types, ['floatrange', 'mood', 'positive_int'])
eq('sequences harvested', names.sequences, ['big_id_seq', 'departments_id_seq', 'employees_id_seq', 'seq_apitest'])
const apitestSeq = schema.body.sequences.find((s) => s.name === 'seq_apitest')
ok('sequence harvest carries type and detail',
  apitestSeq && apitestSeq.dataType === 'bigint' && /inc 10/.test(apitestSeq.detail),
  JSON.stringify(apitestSeq))
const emp = schema.body.tables.find((t) => t.name === 'employees')
eq('identity column surfaced', emp.columns.find((c) => c.name === 'id').type, 'bigint')
eq('generated column surfaced', emp.columns.find((c) => c.name === 'total').type, 'numeric(12,2)')
ok('indexes attached', emp.indexes.length >= 3, `${emp.indexes.length}`)
ok('constraints attached', emp.constraints.some((c) => c.type === 'f'), JSON.stringify(emp.constraints.map((c) => c.type)))
ok('trigger attached', emp.triggers.length === 1, JSON.stringify(emp.triggers.map((t) => t.name)))
ok('built-in functions harvested for completion',
  (schema.body.builtins ?? []).some((f) => f.name === 'json_build_object'),
  `${(schema.body.builtins ?? []).length} built-ins`)
ok('internal pg_ helpers are excluded from built-ins',
  !(schema.body.builtins ?? []).some((f) => f.name.startsWith('pg_')))
ok('built-ins never appear in the browsable function list',
  schema.body.functions.every((f) => f.schema !== 'pg_catalog'))
const deptCount = schema.body.functions.find((f) => f.name === 'dept_count')
eq('function arguments are harvested with names', deptCount.arguments, 'p_name text')
eq('function comment is harvested', deptCount.comment, 'Counts employees in a department.')
ok('built-ins carry a comment field',
  (schema.body.builtins ?? []).every((f) => f.comment === null || typeof f.comment === 'string'))
ok('built-in comments are harvested',
  (schema.body.builtins ?? []).some((f) => typeof f.comment === 'string' && f.comment.length > 0))
ok('grammar constructs absent from pg_proc are offered as built-ins',
  ['coalesce', 'nullif', 'greatest', 'least'].every((name) =>
    (schema.body.builtins ?? []).some((f) => f.name === name && f.schema === 'pg_catalog')))

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
  ['sequence', 'seq_apitest', { oid: schema.body.sequences.find((s) => s.name === 'seq_apitest').oid }, /CREATE SEQUENCE/],
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
const lengths = await q(
  `SELECT 'abc'::varchar(5) AS v, 'x'::character(3) AS c, 't'::text AS t, 1.5::numeric(6,2) AS n`,
  'tab-lengths',
)
eq('declared character lengths resolved (others null)',
  lengths.body.results[0].columnTypeLengths, [5, 3, null, null])
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

console.log('\n== manual transactions across runs ==')
eq('transaction fixture created', (await q('CREATE TABLE tx_check (id integer PRIMARY KEY)', 'tx')).status, 200)
const observer = new Client({ ...base, database: DB })
await observer.connect()
try {
  // An unfinished batch now runs and keeps the transaction open for its tab.
  const begun = await q('BEGIN; INSERT INTO tx_check VALUES (1); INSERT INTO tx_check VALUES (2)', 'tx')
  eq('unfinished batch succeeds', begun.status, 200)
  eq('response reports the open transaction', begun.body.transactionOpen, true)
  eq('its prefix executed on the open transaction',
    (await q('SELECT count(*)::int AS n FROM tx_check', 'tx')).body.results[0].rows[0][0], 2)
  eq('the open transaction is invisible to other connections', (await observer.query('SELECT count(*)::int AS n FROM tx_check')).rows[0].n, 0)

  const rolled = await q('ROLLBACK', 'tx')
  eq('ROLLBACK closes the transaction', rolled.status, 200)
  eq('transactionOpen clears', rolled.body.transactionOpen, false)
  eq('the rollback discarded the rows', (await observer.query('SELECT count(*)::int AS n FROM tx_check')).rows[0].n, 0)

  // COMMIT AND CHAIN commits what is there and opens a fresh transaction.
  eq('begin again', (await q('BEGIN; INSERT INTO tx_check VALUES (3)', 'tx')).body.transactionOpen, true)
  const chained = await q('COMMIT AND CHAIN', 'tx')
  eq('COMMIT AND CHAIN keeps a transaction open', chained.status, 200)
  eq('chained commit reports it', chained.body.transactionOpen, true)
  eq('the chained commit persisted its rows',
    (await observer.query('SELECT id FROM tx_check ORDER BY id')).rows.map((r) => r.id), [3])
  eq('closing the chained transaction', (await q('ROLLBACK', 'tx')).body.transactionOpen, false)

  // A failed statement leaves PostgreSQL's transaction open (aborted); only
  // ROLLBACK can end it, and the response clears the flag.
  eq('begin for the error case', (await q('BEGIN; INSERT INTO tx_check VALUES (4)', 'tx')).body.transactionOpen, true)
  eq('a statement error inside the transaction is reported', (await q('SELECT 1/0', 'tx')).status, 400)
  const aborted = await q('SELECT 1', 'tx')
  eq('the transaction stays open (aborted) until ROLLBACK', aborted.body.code, '25P02')
  eq('ROLLBACK closes the aborted transaction', (await q('ROLLBACK', 'tx')).body.transactionOpen, false)
  eq('the aborted transaction discarded its rows',
    (await observer.query('SELECT id FROM tx_check ORDER BY id')).rows.map((r) => r.id), [3])

  // Transaction identity: the server pins one session per tab and rejects a
  // stale expectation without executing anything.
  const qTxn = (sql, tabKey, transactionId) =>
    call('POST', `/api/connections/${id}/query`, { sql, tabKey, transactionId })
  const txBegin = await qTxn('BEGIN; INSERT INTO tx_check VALUES (30)', 'tx-id')
  eq('begin reports an open transaction', txBegin.body.transactionOpen, true)
  ok('begin reports a transaction id', typeof txBegin.body.transactionId === 'string' && txBegin.body.transactionId.length > 0, txBegin.body.transactionId)
  const txId = txBegin.body.transactionId
  const txContinue = await qTxn('SELECT count(*)::int AS n FROM tx_check', 'tx-id', txId)
  eq('matching id continues the transaction', txContinue.status, 200)
  eq('transaction id is stable', txContinue.body.transactionId, txId)
  const txStale = await qTxn('INSERT INTO tx_check VALUES (31)', 'tx-id', 'stale-id')
  eq('stale id is rejected', txStale.status, 409)
  eq('stale rejection names the conflict', txStale.body.code, 'TRANSACTION_CHANGED')
  eq('stale rejection syncs the live id', txStale.body.transactionId, txId)
  eq('stale batch executed nothing',
    (await qTxn('SELECT count(*)::int AS n FROM tx_check WHERE id = 31', 'tx-id', txId)).body.results[0].rows[0][0], 0)
  const txNull = await qTxn('SELECT 1', 'tx-id', null)
  eq('null id does not join the open transaction', txNull.status, 409)
  const txRowStale = await call('POST', `/api/connections/${id}/row-update`, {
    tabKey: 'tx-id', transactionId: 'stale-id', schema: 'public', table: 'tx_check',
    key: { id: 30 }, set: { id: 30 },
  })
  eq('stale row edit is rejected', txRowStale.status, 409)
  eq('rejected edit leaves the row alone',
    (await qTxn('SELECT count(*)::int AS n FROM tx_check WHERE id = 30', 'tx-id', txId)).body.results[0].rows[0][0], 1)
  eq('rollback with the live id closes it', (await qTxn('ROLLBACK', 'tx-id', txId)).body.transactionOpen, false)
  eq('closed id reports no transaction', (await qTxn('ROLLBACK', 'tx-id', txId)).body.transactionId ?? null, null)
  eq('reusing a closed id is rejected', (await qTxn('SELECT 1', 'tx-id', txId)).status, 409)
  const txEnded = await q('COMMIT; SELECT 1/0', 'tx-ended')
  eq('error after COMMIT is reported', txEnded.status, 400)
  eq('error after COMMIT syncs closed state', txEnded.body.transactionOpen, false)
  eq('error after COMMIT clears the id', txEnded.body.transactionId ?? null, null)

  // Begin/insert and commit across two runs.
  eq('begin+insert across runs', (await q('BEGIN; INSERT INTO tx_check VALUES (10)', 'tx2')).body.transactionOpen, true)
  eq('commit across runs', (await q('COMMIT', 'tx2')).body.transactionOpen, false)
  eq('committed row is visible to other connections', (await observer.query('SELECT id FROM tx_check ORDER BY id')).rows.map((r) => r.id), [3, 10])

  // Closing the tab rolls an open transaction back.
  eq('begin on a third tab', (await q('BEGIN; INSERT INTO tx_check VALUES (11)', 'tx3')).body.transactionOpen, true)
  eq('tab close succeeds', (await call('POST', `/api/connections/${id}/query/close`, { tabKey: 'tx3' })).status, 200)
  eq('tab close rolled the transaction back',
    (await observer.query('SELECT count(*)::int AS n FROM tx_check WHERE id = 11')).rows[0].n, 0)
  eq('the tab is usable again', (await q('SELECT 1', 'tx3')).status, 200)

  // Balanced batches behave exactly as before.
  eq('complete commit succeeds', (await q('BEGIN; INSERT INTO tx_check VALUES (20); COMMIT', 'tx4')).status, 200)
  eq('complete rollback succeeds', (await q('BEGIN; INSERT INTO tx_check VALUES (21); ROLLBACK', 'tx4')).status, 200)
  eq('savepoint rollback leaves enclosing transaction tracked', (await q('INSERT INTO tx_check VALUES (22); SAVEPOINT s; INSERT INTO tx_check VALUES (23); ROLLBACK TO SAVEPOINT s', 'tx4')).status, 200)
  eq('independent connection sees only committed rows', (await observer.query('SELECT id FROM tx_check ORDER BY id')).rows.map(r => r.id), [3, 10, 20, 22])
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

console.log('\n== AI tool surface ==')
{
  const cfg = await call('GET', '/api/ai/config')
  eq('AI config is served', cfg.status, 200)
  ok('config carries url, token and an MCP snippet',
    typeof cfg.body.token === 'string' && cfg.body.token.length >= 32 &&
    /pgdev-mcp/.test(cfg.body.config) && typeof cfg.body.url === 'string',
    JSON.stringify(cfg.body).slice(0, 200))

  const token = cfg.body.token
  ok('the config carries no enabled flag', !('enabled' in (cfg.body ?? {})), JSON.stringify(Object.keys(cfg.body ?? {})))
  const tool = async (name, args) => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/ai/tool/${name}`,
      payload: args ?? {},
      headers: { origin: ORIGIN, authorization: `Bearer ${token}` },
    })
    let body = null
    try {
      body = res.json()
    } catch {
      body = res.body
    }
    return { status: res.statusCode, body }
  }

  const noToken = await app.inject({ method: 'POST', url: '/api/ai/tool/query', payload: { sql: 'SELECT 1' } })
  eq('a tool call without a token is rejected', noToken.statusCode, 401)
  const wrongToken = await app.inject({
    method: 'POST', url: '/api/ai/tool/query', payload: { sql: 'SELECT 1' },
    headers: { origin: ORIGIN, authorization: 'Bearer nope' },
  })
  eq('a wrong token is rejected', wrongToken.statusCode, 401)

  const unknown = await tool('nope')
  eq('an unknown tool is a 404', unknown.status, 404)

  const noRun = await tool('run_active_query')
  eq('there is no tool that runs the editor', noRun.status, 404)

  const noList = await tool('list_connections')
  eq('there is no tool that lists connections', noList.status, 404)

  const read = await tool('query', { sql: 'SELECT g AS n FROM generate_series(1, 3) g ORDER BY g' })
  eq('a read-only query returns rows on the open connection without a browser window', read.status, 200)
  eq('rows come back compactly', read.body.result.results[0].rows, [[1], [2], [3]])
  eq('nothing was mirrored without a window', read.body.result.shown, false)

  const write = await tool('query', { sql: 'CREATE TABLE ai_probe (a integer)' })
  ok('a write is refused before execution',
    write.body.ok === false && /read-only/.test(write.body.error), JSON.stringify(write.body))

  const cte = await tool('query', {
    sql: "WITH x AS (INSERT INTO departments (name) VALUES ('ai') RETURNING id) SELECT * FROM x",
  })
  ok('the database refuses a data-modifying CTE in the read-only transaction',
    cte.body.ok === false && /read-only transaction/i.test(cte.body.error), JSON.stringify(cte.body))
  eq('the refused CTE inserted nothing',
    (await q("SELECT count(*)::int AS n FROM departments WHERE name = 'ai'", 'ai-check')).body.results[0].rows[0][0], 0)

  const filtered = await tool('get_schema', { table: 'departments' })
  eq('get_schema filters to the named relation',
    filtered.body.result.tables.map((t) => t.name), ['departments'])
  eq('get_schema carries sequences',
    filtered.body.result.sequences.map((s) => s.name), [])

  const deptOid = schema.body.tables.find((t) => t.name === 'departments').oid
  const ddl = await tool('get_ddl', { type: 'table', schema: 'public', name: 'departments', oid: deptOid })
  ok('get_ddl returns generated DDL', /CREATE TABLE/.test(ddl.body.result?.ddl ?? ''), JSON.stringify(ddl.body).slice(0, 120))

  const badDdl = await tool('get_ddl', { type: 'sequence', schema: 'public', name: 'x' })
  ok('get_ddl validates the object type', badDdl.body.ok === false, JSON.stringify(badDdl.body))

  const editor = await tool('get_active_query')
  ok('editor tools report the missing window',
    editor.body.ok === false && /No pgDEV window/.test(editor.body.error), JSON.stringify(editor.body))

  const result = await tool('get_active_result')
  ok('the active result needs a window too',
    result.body.ok === false && /No pgDEV window/.test(result.body.error), JSON.stringify(result.body))

  for (const name of ['list_tabs', 'activate_tab', 'close_tab']) {
    const missing = await tool(name, { tab: 'sql-1' })
    ok(`${name} reports the missing window`,
      missing.body.ok === false && /No pgDEV window/.test(missing.body.error), JSON.stringify(missing.body))
  }

  const stray = await call('POST', '/api/ai/bridge/result', { id: 'missing', result: 1 })
  eq('an unknown bridge result is ignored', stray.body.ok, false)

  // The browser owns the limits; the endpoint validates and applies them.
  const defaults = (await call('GET', '/api/ai/config')).body.limits
  eq('config reports the default limits', defaults, { maxRows: 100, maxBytes: 65536 })

  const badRows = await call('PUT', '/api/ai/limits', { maxRows: 0, maxBytes: 65536 })
  eq('a row limit outside the range is rejected', badRows.status, 400)
  const badBytes = await call('PUT', '/api/ai/limits', { maxRows: 100, maxBytes: 12 })
  eq('a byte limit outside the range is rejected', badBytes.status, 400)

  const set = await call('PUT', '/api/ai/limits', { maxRows: 2, maxBytes: 65536 })
  eq('valid limits are accepted', set.body, { maxRows: 2, maxBytes: 65536 })
  eq('config reports them back', (await call('GET', '/api/ai/config')).body.limits, { maxRows: 2, maxBytes: 65536 })
  // Earlier sections intentionally retain a paged session (tab "cte"), so the
  // baseline counts the idle-in-transaction backends before the read; the
  // assertion is that the agent read adds none. (The counting batch itself is
  // active while it snapshots, so it never counts itself.)
  const idleCount = async (tabKey) =>
    (await q("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND application_name = 'pgDEV' AND state LIKE 'idle in transaction%'", tabKey))
      .body.results[0].rows[0][0]
  const idleBefore = await idleCount('ai-idle-before')
  const capped = await tool('query', { sql: 'SELECT g FROM generate_series(1, 5) g' })
  eq('the row limit applies to the next query', capped.body.result.results[0].rows, [[1], [2]])
  eq('and is reported as truncated', capped.body.result.results[0].truncated, true)
  eq('only the capped rows come back', capped.body.result.results[0].rowCount, 2)
  // One-shot agent reads: the cut result is a bounded limited batch, so no
  // cursor session (idle in transaction) is left pinning a pool client the
  // mirror tab could never page anyway.
  ok('an agent read leaves no cursor session behind', (await idleCount('ai-idle-after')) <= idleBefore,
    `idle in transaction ${idleBefore} -> ${await idleCount('ai-idle-after')}`)
  const restored = await call('PUT', '/api/ai/limits', defaults)
  eq('the browser can put the defaults back', restored.body, defaults)

  // The token is stable: another app on the same file gets the same token —
  // the MCP configuration survives a restart.
  const app2 = await createApp({ serveStatic: false, aiTokenFile })
  const token2 = (await app2.inject({ method: 'GET', url: '/api/ai/config', headers: { origin: ORIGIN } })).json().token
  eq('a second boot reads the same token', token2, token)
  await app2.close()

  // Deleting the file rotates: the next boot mints and stores a fresh one.
  rmSync(aiTokenFile)
  const app3 = await createApp({ serveStatic: false, aiTokenFile })
  const token3 = (await app3.inject({ method: 'GET', url: '/api/ai/config', headers: { origin: ORIGIN } })).json().token
  ok('rotation mints a fresh token', token3 !== token && /^[0-9a-f]{64}$/.test(token3), JSON.stringify(token3).slice(0, 20))
  // (app3 has no connection open, so the tools answer 200 with a not-connected
  // error; the assertions below are about the token, not the connection.)
  eq('and the fresh token is accepted', (await app3.inject({
    method: 'POST', url: '/api/ai/tool/get_schema', payload: {},
    headers: { origin: ORIGIN, authorization: `Bearer ${token3}` },
  })).statusCode, 200)
  eq('while the old one no longer is', (await app3.inject({
    method: 'POST', url: '/api/ai/tool/get_schema', payload: {},
    headers: { origin: ORIGIN, authorization: `Bearer ${token}` },
  })).statusCode, 401)
  await app3.close()
  rmSync(aiTokenFile, { force: true })
}

console.log('\n== disconnect ==')
const del = await call('DELETE', `/api/connections/${id}`)
eq('connection closes', del.status, 200)
const gone = await call('GET', `/api/connections/${id}/schema`)
eq('closed connection is unknown', gone.status, 404)

console.log('\n== AI without a connection ==')
{
  // Nothing is open any more, so the database tools must say so instead of
  // guessing a connection to work on.
  const token = (await call('GET', '/api/ai/config')).body.token
  const offline = (
    await app.inject({
      method: 'POST',
      url: '/api/ai/tool/query',
      payload: { sql: 'SELECT 1' },
      headers: { origin: ORIGIN, authorization: `Bearer ${token}` },
    })
  ).json()
  ok('a database tool without a connection says so',
    offline.ok === false && /not connected to a database/i.test(offline.error), JSON.stringify(offline))
}

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
