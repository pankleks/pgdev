// Live API suite: the agent surface — token auth and rotation, the
// read-only query tool (classifier refusal, data-modifying CTE refusal),
// filtered get_schema/get_ddl, the no-window editor errors, the bridge
// result sink, and the row-limit endpoint.
import { rmSync } from 'node:fs'
import { boot, createApp } from './setup.mjs'
import { counters } from '../lib/db.mjs'

const { base, DB, app, ORIGIN, aiTokenFile, call, cleanup } = await boot('ai')
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
const left = await cleanup()
console.log(`\nleftover pgdev_% databases: ${JSON.stringify(left)}`)
process.exit(report() ? 0 : 1)
