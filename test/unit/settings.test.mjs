import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceLoader } from '../lib/load.mjs'

const load = sourceLoader()
// In Node there is no IndexedDB, so the settings store runs on its in-memory
// defaults — exactly what these behaviors exercise.
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

test('statement timeout is clamped to 1-600 seconds', () => {
  settings.setStatementTimeout(0)
  assert.equal(settings.state.statementTimeout, 1)
  settings.setStatementTimeout(99999)
  assert.equal(settings.state.statementTimeout, 600)
  settings.setStatementTimeout(45.6)
  assert.equal(settings.state.statementTimeout, 46)
  settings.setStatementTimeout(Number.NaN)
  assert.equal(settings.state.statementTimeout, 30)
})

test('editor font size is clamped to 8-32 px', () => {
  settings.setEditorFontSize(3)
  assert.equal(settings.state.editorFontSize, 8)
  settings.setEditorFontSize(200)
  assert.equal(settings.state.editorFontSize, 32)
  settings.setEditorFontSize(11.4)
  assert.equal(settings.state.editorFontSize, 11)
  settings.setEditorFontSize(Number.NaN)
  assert.equal(settings.state.editorFontSize, 14)
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
