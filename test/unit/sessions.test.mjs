import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceLoader } from '../lib/load.mjs'

const sessions = await sourceLoader()('server/sessions.ts')
const {
  sessionKey, getSession, transactionState, parseTransactionId, assertTransaction,
  setSession, beginSession, finishSession, teardownSession, closeSessionsForClient,
} = sessions

// Per-tab cursor/transaction state: the pinning, 409-conflict and reaper
// arming rules decide whether a batch runs, waits or is refused.

let seq = 0
const key = () => `conn-1|tab-sessions-${++seq}`
const stubClient = () => {
  const queries = []
  return {
    queries,
    released: 0,
    query: async (sql) => {
      queries.push(sql)
      return { rows: [] }
    },
    release: () => {},
  }
}
const tracked = () => {
  const c = stubClient()
  let released = 0
  const orig = c.release
  c.release = () => {
    released++
    orig()
  }
  return { client: c, wasReleased: () => released > 0 }
}

test('sessionKey joins connection and tab', () => {
  assert.equal(sessionKey('c', 't'), 'c|t')
})

test('parseTransactionId passes through absence and validates presence', () => {
  assert.equal(parseTransactionId(undefined), undefined)
  assert.equal(parseTransactionId(null), null)
  assert.equal(parseTransactionId('abc'), 'abc')
  for (const bad of ['', 'x'.repeat(129), 42, {}, []]) {
    assert.throws(() => parseTransactionId(bad), /Invalid transaction id/, JSON.stringify(bad))
  }
})

test('assertTransaction skips legacy callers and conflicts on change', async () => {
  const k = key()
  const { client } = tracked()
  setSession(k, 'conn-1', client, null, null, 'transaction')
  const id = transactionState(k).transactionId
  assertTransaction(k, undefined)
  assertTransaction(k, id)
  // A cursor-only session has no transaction id: expecting one conflicts.
  const kc = key()
  setSession(kc, 'conn-1', client, 'cur', null, 'cursor')
  let err
  try {
    assertTransaction(kc, id)
  } catch (e) {
    err = e
  }
  assert.match(err?.message ?? '', /ended or changed/)
  assert.equal(err?.statusCode, 409)
  assert.equal(err?.code, 'TRANSACTION_CHANGED')
  await teardownSession(k, 'rollback')
  await teardownSession(kc, 'rollback')
})

test('transactionState reflects only open user transactions', async () => {
  assert.deepEqual(transactionState('conn-1|missing'), { transactionId: null, transactionOpen: false })
  const { client } = tracked()
  const kc = key()
  setSession(kc, 'conn-1', client, 'cur', null, 'cursor')
  assert.deepEqual(transactionState(kc), { transactionId: null, transactionOpen: false })
  const kt = key()
  setSession(kt, 'conn-1', client, null, null, 'transaction')
  const st = transactionState(kt)
  assert.equal(st.transactionOpen, true)
  assert.ok(st.transactionId)
  await teardownSession(kc, 'rollback')
  await teardownSession(kt, 'rollback')
})

test('the reaper is armed whenever a transaction may be left open', async () => {
  const { client } = tracked()
  const kCursor = key()
  setSession(kCursor, 'conn-1', client, 'cur', null, 'cursor')
  assert.ok(getSession(kCursor).timer, 'cursor session arms the reaper')
  const kTxn = key()
  setSession(kTxn, 'conn-1', client, null, null, 'transaction')
  assert.ok(getSession(kTxn).timer, 'user transaction arms the reaper')
  const kIdle = key()
  setSession(kIdle, 'conn-1', client, null, null, 'cursor')
  assert.equal(getSession(kIdle).timer, null, 'nothing pending arms nothing')
  await teardownSession(kCursor, 'rollback')
  await teardownSession(kTxn, 'rollback')
  await teardownSession(kIdle, 'rollback')
})

test('beginSession guards the busy flag and disarms the timer', async () => {
  const { client } = tracked()
  const k = key()
  setSession(k, 'conn-1', client, 'cur', null, 'cursor')
  const s = beginSession(k)
  assert.ok(s)
  assert.equal(beginSession(k), undefined, 'a busy session cannot be entered twice')
  assert.equal(getSession(k).timer, null)
  await finishSession(k, s, 'rollback')
  assert.equal(getSession(k), undefined)
})

test('teardown of a busy session defers to the running batch', async () => {
  const { client, wasReleased } = tracked()
  const k = key()
  setSession(k, 'conn-1', client, 'cur', null, 'cursor')
  const s = beginSession(k)
  await teardownSession(k, 'rollback')
  assert.equal(wasReleased(), false, 'the running batch still owns the client')
  assert.equal(getSession(k).closeRequested, true)
  await finishSession(k, s, 'keep')
  assert.equal(getSession(k), undefined, 'keep honours the deferred close with a rollback')
  assert.deepEqual(client.queries, ['ROLLBACK'])
})

test('finishSession commits and releases an idle session', async () => {
  const { client, wasReleased } = tracked()
  const k = key()
  setSession(k, 'conn-1', client, null, null, 'transaction')
  const s = beginSession(k)
  await finishSession(k, s, 'commit')
  assert.deepEqual(client.queries, ['COMMIT'])
  assert.equal(wasReleased(), true)
  assert.equal(getSession(k), undefined)
})

test('closeSessionsForClient drops sessions pinned to a dead client', async () => {
  const { client } = tracked()
  const other = stubClient()
  const k1 = key()
  const k2 = key()
  setSession(k1, 'conn-1', client, 'cur', null, 'cursor')
  setSession(k2, 'conn-1', other, 'cur', null, 'cursor')
  await closeSessionsForClient(client)
  assert.equal(getSession(k1), undefined)
  assert.ok(getSession(k2), 'sessions on other clients survive')
  await teardownSession(k2, 'rollback')
})
