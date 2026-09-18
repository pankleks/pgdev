// Live API suite: transactions, paging and slow-query handling — manual
// transactions spanning runs (rollback, chained commit, aborted, tab-close,
// identity pinning), bounded direct results, cursor paging, the statement
// timeout, cancellation, the catalog pool surviving pinned sessions, and
// disconnects cancelling in-flight queries.
import { boot, Client } from './setup.mjs'
import { counters } from '../lib/db.mjs'

const { base, DB, app, ORIGIN, call, cleanup } = await boot('txnpage')
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

console.log('\n== statement timeout and cancellation ==')
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
const left = await cleanup()
console.log(`\nleftover pgdev_% databases: ${JSON.stringify(left)}`)
process.exit(report() ? 0 : 1)
