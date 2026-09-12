import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceLoader } from '../lib/load.mjs'

const load = sourceLoader()
// In Node there is no IndexedDB/localStorage, so the settings store runs on
// its in-memory defaults — exactly what these behaviors exercise.
const { useSettings } = await load('web/composables/settings.ts')
const settings = useSettings()
await settings.ready

test('panel sizes are clamped to the splitter limits', () => {
  settings.setPanelSizes(50, 999999)
  assert.equal(settings.state.panelSizes.sideW, 180)
  assert.equal(settings.state.panelSizes.resultsH, 4000)
  settings.setPanelSizes(480.7, 260.2)
  assert.equal(settings.state.panelSizes.sideW, 481)
  assert.equal(settings.state.panelSizes.resultsH, 260)
  settings.setPanelSizes(Number.NaN, undefined)
  assert.equal(settings.state.panelSizes.sideW, 336)
  assert.equal(settings.state.panelSizes.resultsH, 240)
})

test('browser state is stored per connection and sanitized on write', () => {
  settings.setBrowserState('pg@localhost:5432/app', {
    sections: { tables: true, views: false, functions: false, types: 'yes' },
    expanded: ['t-1', 42, 't-2-cols'],
    groups: { tables: ['g'], views: null, functions: [], types: [] },
  })
  const saved = settings.browserStateFor('pg@localhost:5432/app')
  assert.deepEqual(saved.sections, { tables: true, views: false, functions: false, types: false })
  assert.deepEqual(saved.expanded, ['t-1', 't-2-cols'])
  assert.deepEqual(saved.groups, { tables: ['g'], views: [], functions: [], types: [] })
  // Without a label nothing is stored.
  settings.setBrowserState('', { sections: { tables: true, views: false, functions: false, types: false }, expanded: [], groups: {} })
  assert.equal(settings.browserStateFor(''), null)
  assert.equal(settings.browserStateFor('unknown-connection'), null)
})
