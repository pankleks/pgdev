import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceLoader } from '../lib/load.mjs'

const load = sourceLoader()
const { useTabs } = await load('web/composables/tabs.ts')
const tabs = useTabs()
await tabs.pinsReady

const keys = () => tabs.state.tabs.map((t) => t.key)

test('moveTabToIndex reorders forward, backward and in place', () => {
  tabs.newQuery()
  tabs.newQuery()
  tabs.newQuery()
  const [a, b, c] = keys()
  const active = tabs.state.activeKey

  // Move the last tab to the front.
  tabs.moveTabToIndex(c, 0)
  assert.deepEqual(keys(), [c, a, b])
  assert.equal(tabs.state.activeKey, active, 'active tab is independent of order')

  // Move it back to the end.
  tabs.moveTabToIndex(c, 3)
  assert.deepEqual(keys(), [a, b, c])

  // Dropping in place (index === from or from + 1) is a no-op.
  tabs.moveTabToIndex(a, 0)
  tabs.moveTabToIndex(a, 1)
  assert.deepEqual(keys(), [a, b, c])

  // Unknown keys are ignored; out-of-range indices clamp to the end.
  tabs.moveTabToIndex('missing', 0)
  tabs.moveTabToIndex(b, 99)
  assert.deepEqual(keys(), [a, c, b])
})
