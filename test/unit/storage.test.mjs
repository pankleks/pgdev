import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceLoader } from '../lib/load.mjs'

// The module reads localStorage while loading, so the stub must exist first.
// With indexedDB absent, storage.ts runs in legacy mode where the localStorage
// key is the pinned files' only home — exactly the path that must not report
// success when the write fails.
globalThis.localStorage = {
  getItem: () => null,
  setItem: () => {
    throw new Error('QuotaExceededError')
  },
  removeItem: () => undefined,
}

const load = sourceLoader()
const { savePinnedFiles } = await load('web/lib/storage.ts')

test('a pinned-file save no store can accept rejects instead of reporting success', async () => {
  await assert.rejects(
    () => savePinnedFiles([{ id: 'p1', order: 0, fileName: 'q.sql', content: 'select 1' }]),
    /Quota/,
  )
})
