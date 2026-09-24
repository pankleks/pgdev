import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceLoader } from '../lib/load.mjs'

const load = sourceLoader()
const { useTabs } = await load('web/composables/tabs.ts')
const { serializeSession } = await load('web/lib/tabsession.ts')
const tabs = useTabs()
await tabs.pinsReady

const keys = () => tabs.state.tabs.map((t) => t.key)

function addTestPin(tab) {
  const id = `test-pin-${tab.key}`
  tabs.state.pinnedFiles.push({
    id,
    order: tabs.state.pinnedFiles.length,
    fileName: tab.fileName ?? tab.title,
    content: tab.savedContent ?? tab.content,
  })
  tab.pinnedId = id
  return id
}

function removeTestPin(id) {
  const index = tabs.state.pinnedFiles.findIndex((pin) => pin.id === id)
  if (index !== -1) tabs.state.pinnedFiles.splice(index, 1)
  for (const tab of tabs.state.tabs) {
    if (tab.pinnedId === id) tab.pinnedId = undefined
  }
}

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

test('only user-created query tabs are marked always-persisted', () => {
  tabs.newQuery()
  const created = tabs.state.tabs[tabs.state.tabs.length - 1]
  assert.equal(created.persist, true, 'New query tabs always join the session')

  tabs.openDdl('table', 'public', 'persist_probe', 'CREATE TABLE probe ()', '', true, '', 'conn-id')
  assert.equal(tabs.state.tabs[tabs.state.tabs.length - 1].persist, undefined, 'DDL tabs are not always-persisted')

  tabs.openSqlTab('Edit probe', 'ALTER TABLE probe ADD COLUMN c int', 'conn-id')
  assert.equal(tabs.state.tabs[tabs.state.tabs.length - 1].persist, undefined, 'generated SQL is not')

  tabs.openFile('probe.sql', 'select 1')
  assert.equal(tabs.state.tabs[tabs.state.tabs.length - 1].persist, undefined, 'file tabs are not')
})

test('showAiLog is a single read-only tab that accumulates entries', () => {
  const key = tabs.showAiLog('SELECT 1')
  assert.equal(key, 'ai-log')
  const tab = tabs.state.tabs.find((t) => t.key === key)
  assert.equal(tab.readOnly, true, 'the AI log is read-only')
  assert.equal(tab.aiMirror, true)
  assert.equal(tab.connectionId, undefined, 'the AI log is not connection bound')
  assert.equal(tabs.isDirty(tab), false, 'the AI log can never be dirty')
  assert.equal(tabs.state.activeKey, key)

  const again = tabs.showAiLog('SELECT 2')
  assert.equal(again, key)
  assert.equal(tabs.state.tabs.filter((t) => t.aiMirror === true).length, 1, 'never duplicated')
  assert.equal(tab.content, 'SELECT 1\n\nSELECT 2')
})

test('opening a pinned file focuses its existing clean tab', async () => {
  tabs.openFile('clean-pin.sql', 'SELECT 1')
  const original = tabs.state.tabs[tabs.state.tabs.length - 1]
  const pinId = addTestPin(original)

  tabs.newQuery()
  const otherKey = tabs.state.activeKey
  const countBefore = tabs.state.tabs.length

  assert.equal(await tabs.openPinned(pinId), 'focused')
  assert.equal(tabs.state.activeKey, original.key)
  assert.equal(tabs.state.tabs.length, countBefore, 'does not create a duplicate tab')

  removeTestPin(pinId)
  tabs.close(original.key)
  tabs.close(otherKey)
})

test('opening a pinned file creates a new tab when its existing tab is dirty', async () => {
  tabs.openFile('dirty-pin.sql', 'SELECT 1')
  const original = tabs.state.tabs[tabs.state.tabs.length - 1]
  const pinId = addTestPin(original)
  tabs.updateContent(original.key, 'SELECT 2')

  tabs.newQuery()
  const otherKey = tabs.state.activeKey
  const countBefore = tabs.state.tabs.length

  assert.equal(await tabs.openPinned(pinId), 'snapshot')
  const opened = tabs.state.tabs.find((tab) => tab.key === tabs.state.activeKey)
  assert.ok(opened)
  assert.notEqual(opened.key, original.key)
  assert.equal(opened.content, 'SELECT 1', 'opens the pinned saved copy')
  assert.equal(original.content, 'SELECT 2', 'preserves edits in the dirty tab')
  assert.equal(tabs.state.tabs.length, countBefore + 1)

  removeTestPin(pinId)
  tabs.close(original.key)
  tabs.close(opened.key)
  tabs.close(otherKey)
})

test('a dirty non-query tab joins the session', () => {
  tabs.openDdl('table', 'public', 'dirty_probe', 'CREATE TABLE probe ()', '', true, '', 'conn-id')
  const ddl = tabs.state.tabs[tabs.state.tabs.length - 1]
  assert.ok(!serializeSession(tabs.state.tabs, ddl.key).tabs.some((t) => t.key === ddl.key),
    'a clean DDL tab stays out')

  tabs.updateContent(ddl.key, 'CREATE TABLE probe (id int)')
  const stored = serializeSession(tabs.state.tabs, ddl.key).tabs.find((t) => t.key === ddl.key)
  assert.ok(stored, 'the edited DDL tab joins the session')
  assert.equal(stored.kind, 'ddl')
  assert.equal(stored.savedContent, 'CREATE TABLE probe ()')
})
