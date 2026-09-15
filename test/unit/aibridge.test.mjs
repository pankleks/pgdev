import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceLoader } from '../lib/load.mjs'

const load = sourceLoader()
const { createBridge, BridgeError } = await load('server/ai/bridge.ts')

// The bridge carries tool actions to the browser and the answers back; the
// failure modes (no window, no answer, window closed) must be typed so the
// tools can turn them into readable messages.

test('a subscribed window receives actions and answers them', async () => {
  const bridge = createBridge(1000)
  const events = []
  const unsubscribe = bridge.subscribe((event) => events.push(JSON.parse(event)))
  assert.equal(bridge.connected(), true)

  const pending = bridge.request('get-context', { level: 2 })
  assert.equal(events.length, 1)
  assert.equal(events[0].action, 'get-context')
  assert.deepEqual(events[0].args, { level: 2 })
  assert.equal(typeof events[0].id, 'string')

  assert.equal(bridge.resolve(events[0].id, { activeKey: 'query-1' }), true)
  assert.deepEqual(await pending, { activeKey: 'query-1' })
  // A duplicate answer for the same action is ignored.
  assert.equal(bridge.resolve(events[0].id, {}), false)
  unsubscribe()
  assert.equal(bridge.connected(), false)
})

test('no window, timeout and disconnect are typed failures', async () => {
  const bridge = createBridge(20)
  await assert.rejects(
    bridge.request('get-context'),
    (err) => err instanceof BridgeError && err.code === 'no-window',
  )

  const unsubscribe = bridge.subscribe(() => undefined)
  await assert.rejects(
    bridge.request('get-context'),
    (err) => err instanceof BridgeError && err.code === 'timeout',
  )
  unsubscribe()

  const unsubscribe2 = bridge.subscribe(() => undefined)
  const pending = bridge.request('get-context')
  unsubscribe2()
  await assert.rejects(
    pending,
    (err) => err instanceof BridgeError && err.code === 'disconnected',
  )
})

test('a second window is refused instead of broadcast to', async () => {
  const bridge = createBridge(1000)
  const first = []
  const second = []
  const unsubscribeA = bridge.subscribe((event) => first.push(JSON.parse(event)))
  const unsubscribeB = bridge.subscribe((event) => second.push(JSON.parse(event)))
  assert.equal(bridge.count(), 2)

  await assert.rejects(
    bridge.request('set-active-query', { sql: 'SELECT 1' }),
    (err) => err instanceof BridgeError && err.code === 'multiple' && /2 pgDEV windows/.test(err.message),
  )
  // Neither window saw the action, so it cannot run twice.
  assert.deepEqual(first, [])
  assert.deepEqual(second, [])

  unsubscribeB()
  const pending = bridge.request('get-context')
  assert.equal(first.length, 1)
  bridge.resolve(first[0].id, { activeKey: 'query-1' })
  assert.deepEqual(await pending, { activeKey: 'query-1' })
  unsubscribeA()
})

test('an error answer rejects the waiting call', async () => {
  const bridge = createBridge(1000)
  const events = []
  const unsubscribe = bridge.subscribe((event) => events.push(JSON.parse(event)))
  const pending = bridge.request('set-active-query', { sql: 'SELECT 1' })
  bridge.resolve(events[0].id, null, 'The active tab is read-only.')
  await assert.rejects(pending, /read-only/)
  unsubscribe()
})
