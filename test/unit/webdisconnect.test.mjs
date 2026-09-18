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

test('disconnect surfaces the server result', async () => {
  for (const [status, body, wantThrow] of [
    [200, {}, false],
    [500, { error: 'boom' }, true],
  ]) {
    stubFetch(status, body)
    if (wantThrow) await assert.rejects(api.disconnect('conn-1'), /boom/)
    else await api.disconnect('conn-1')
  }
})
