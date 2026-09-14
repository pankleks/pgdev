import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceLoader } from '../lib/load.mjs'

// The module reads localStorage while loading, so the stub must exist first.
// With indexedDB absent, storage.ts runs in legacy mode where localStorage is
// the only store; write failures are simulated by making setItem throw.
const store = new Map()
let failWrites = true
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => {
    if (failWrites) throw new Error('QuotaExceededError')
    store.set(key, String(value))
  },
  removeItem: (key) => store.delete(key),
}

const load = sourceLoader()
const { savePinnedFiles, saveTabSession, loadTabSession } = await load('web/lib/storage.ts')

test('a pinned-file save no store can accept rejects instead of reporting success', async () => {
  await assert.rejects(
    () => savePinnedFiles([{ id: 'p1', order: 0, fileName: 'q.sql', content: 'select 1' }]),
    /Quota/,
  )
})

test('the tab session round-trips through the fallback store', async () => {
  failWrites = false
  const session = {
    tabs: [
      { key: 'query-1', title: 'Query 1', content: 'select 1' },
      { key: 'query-2', title: 'Query 2', content: 'select 2' },
    ],
    activeIndex: 1,
  }
  await saveTabSession(session)
  assert.deepEqual(await loadTabSession(), session)
})

test('a failed session write leaves any previous copy in place', async () => {
  failWrites = false
  await saveTabSession({ tabs: [{ key: 'query-1', title: 'Query 1', content: 'kept' }], activeIndex: 0 })
  failWrites = true
  await assert.rejects(
    () => saveTabSession({ tabs: [], activeIndex: 0 }),
    /Quota/,
  )
  failWrites = false
  const loaded = await loadTabSession()
  assert.deepEqual(loaded.tabs.map((t) => t.content), ['kept'], 'the last good copy survives')
})

test('missing or corrupt session data reads as nothing saved', async () => {
  store.delete('pgdev.tabs')
  assert.equal(await loadTabSession(), null)

  store.set('pgdev.tabs', '{not json')
  assert.equal(await loadTabSession(), null)

  store.set('pgdev.tabs', JSON.stringify({ tabs: 'not an array' }))
  assert.equal(await loadTabSession(), null)
})
