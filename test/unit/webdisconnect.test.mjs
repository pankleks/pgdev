import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceLoader } from '../lib/load.mjs'

const load = sourceLoader()
const { api } = await load('web/api.ts')

// A failed DELETE must surface: the connection composable keeps UI state and
// toasts instead of phantom-clearing to "not connected".

function stubFetch(status, body = {}) {
  globalThis.fetch = async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })
}

test('disconnect resolves when the server closes the pool', async () => {
  stubFetch(200, {})
  await api.disconnect('conn-1')
})

test('disconnect throws when the server reports failure', async () => {
  stubFetch(500, { error: 'boom' })
  await assert.rejects(api.disconnect('conn-1'), /boom/)
})
