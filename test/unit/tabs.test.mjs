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

test('only user-created query tabs are marked for session persistence', () => {
  tabs.newQuery()
  const created = tabs.state.tabs[tabs.state.tabs.length - 1]
  assert.equal(created.persist, true, 'New query tabs join the session')

  tabs.openDdl('table', 'public', 'persist_probe', 'CREATE TABLE probe ()', '', true, '', 'conn-id')
  assert.equal(tabs.state.tabs[tabs.state.tabs.length - 1].persist, undefined, 'DDL tabs do not')

  tabs.openSqlTab('Edit probe', 'ALTER TABLE probe ADD COLUMN c int', 'conn-id')
  assert.equal(tabs.state.tabs[tabs.state.tabs.length - 1].persist, undefined, 'generated SQL does not')

  tabs.openFile('probe.sql', 'select 1')
  assert.equal(tabs.state.tabs[tabs.state.tabs.length - 1].persist, undefined, 'file tabs do not')
})
