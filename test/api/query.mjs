// Live API suite: the documented read surface end to end — the origin
// guard, connect, /schema, /ddl for every object type, query execution
// (multi-statement batches, JSON raw-text paths), DDL through the query
// tool, error/SQLSTATE reporting, VACUUM autocommit and maxRows validation.
import { boot } from './setup.mjs'
import { counters } from '../lib/db.mjs'

const { base, DB, app, ORIGIN, call, cleanup } = await boot('query')
const { eq, ok, report } = counters()

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

console.log('\n== errors, VACUUM and maxRows ==')
const syntax = await q('SELECT * FROM nonexistent_table_xyz', 'err1')
eq('syntax/relation error status', syntax.status, 400)
ok('error message surfaced', /nonexistent_table_xyz/.test(syntax.body.error), syntax.body.error)
ok('SQLSTATE surfaced', /^[0-9A-Z]{5}$/.test(syntax.body.code), String(syntax.body.code))

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
const left = await cleanup()
console.log(`\nleftover pgdev_% databases: ${JSON.stringify(left)}`)
process.exit(report() ? 0 : 1)
