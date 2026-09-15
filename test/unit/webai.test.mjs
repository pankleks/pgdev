import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceLoader } from '../lib/load.mjs'

const load = sourceLoader()
const { applyBridgeAction, AI_TAB_TITLE } = await load('web/lib/aibridge.ts')

// The browser's half of the AI bridge, pure over injected stores.

function setup() {
  const tabs = [
    { key: 'query-1', title: 'Query 1', readOnly: false, content: 'SELECT 1' },
    { key: 'ddl-1', title: 'items', readOnly: true, content: 'CREATE TABLE items ();' },
  ]
  const state = {
    activeKey: 'query-1',
    fallback: tabs[1],
    written: [],
    opened: [],
    grids: [],
    activated: [],
    inserted: [],
  }
  let counter = 1
  const deps = {
    connectionId: () => 'conn-1',
    connectionLabel: () => 'local',
    tabs: () => tabs,
    activeKey: () => state.activeKey,
    activateTab: (key) => {
      state.activeKey = key
      state.activated.push(key)
    },
    openSqlTab: (title, content, connectionId) => {
      const key = `sql-${++counter}`
      tabs.push({ key, title, readOnly: false, content })
      state.activeKey = key
      state.opened.push({ key, title, content, connectionId })
    },
    updateContent: (key, content) => {
      const tab = tabs.find((t) => t.key === key)
      if (tab) tab.content = content
      state.written.push({ key, content })
    },
    showGrid: (key, grid) => state.grids.push({ key, grid }),
    insertAtCursor: (sql) => {
      state.inserted.push(sql)
      return true
    },
  }
  return { deps, state, tabs }
}

test('get-context reports the active connection and tabs', async () => {
  const { deps } = setup()
  const context = await applyBridgeAction(deps, { id: '1', action: 'get-context' })
  assert.equal(context.connectionId, 'conn-1')
  assert.equal(context.connectionLabel, 'local')
  assert.equal(context.activeKey, 'query-1')
  assert.deepEqual(context.tabs, [
    { key: 'query-1', title: 'Query 1', readOnly: false },
    { key: 'ddl-1', title: 'items', readOnly: true },
  ])
})

test('get-active-query returns the active tab content and its read-only flag', async () => {
  const { deps, state } = setup()
  assert.deepEqual(await applyBridgeAction(deps, { id: '1', action: 'get-active-query' }), {
    sql: 'SELECT 1',
    readOnly: false,
  })
  state.activeKey = 'ddl-1'
  assert.deepEqual(await applyBridgeAction(deps, { id: '2', action: 'get-active-query' }), {
    sql: 'CREATE TABLE items ();',
    readOnly: true,
  })
})

test('set-active-query replaces, appends and inserts', async () => {
  const { deps, state } = setup()
  await applyBridgeAction(deps, { id: '1', action: 'set-active-query', args: { sql: 'SELECT 2' } })
  assert.equal(state.written.at(-1).content, 'SELECT 2')

  await applyBridgeAction(deps, { id: '2', action: 'set-active-query', args: { sql: 'SELECT 3', mode: 'append' } })
  assert.equal(state.written.at(-1).content, 'SELECT 2\n\nSELECT 3')

  await applyBridgeAction(deps, { id: '3', action: 'set-active-query', args: { sql: 'SELECT 4', mode: 'insert' } })
  assert.deepEqual(state.inserted, ['SELECT 4'])
})

test('set-active-query refuses read-only tabs and empty SQL', async () => {
  const { deps, state } = setup()
  state.activeKey = 'ddl-1'
  // The refusal has to say where the change can go instead.
  await assert.rejects(
    applyBridgeAction(deps, { id: '1', action: 'set-active-query', args: { sql: 'SELECT 1' } }),
    /read-only.*open_query_tab/,
  )
  state.activeKey = 'query-1'
  await assert.rejects(
    applyBridgeAction(deps, { id: '2', action: 'set-active-query', args: { sql: '   ' } }),
    /"sql" is required/,
  )
})

test('authored DDL is staged in the active tab, never run', async () => {
  const { deps, state } = setup()
  const ddl = 'CREATE OR REPLACE FUNCTION public.f() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;'
  const applied = await applyBridgeAction(deps, { id: '1', action: 'set-active-query', args: { sql: ddl } })
  assert.deepEqual(applied, { sql: ddl })
  assert.equal(state.written.at(-1).content, ddl)
  assert.deepEqual(state.grids, [])
})

test('open-query-tab creates a tab and returns its key', async () => {
  const { deps, state } = setup()
  const opened = await applyBridgeAction(deps, {
    id: '1',
    action: 'open-query-tab',
    args: { sql: 'CREATE VIEW v AS SELECT 1', title: 'v' },
  })
  assert.equal(opened.title, 'v')
  assert.deepEqual(state.opened[0], {
    key: opened.key,
    title: 'v',
    content: 'CREATE VIEW v AS SELECT 1',
    connectionId: 'conn-1',
  })
})

test('show-result reuses the AI tab and renders the grid', async () => {
  const { deps, state } = setup()
  const grid = {
    sql: 'SELECT id FROM items',
    columns: ['id'],
    columnTypes: ['integer'],
    rows: [[1]],
    rowCount: 1,
    truncated: false,
  }
  const first = await applyBridgeAction(deps, { id: '1', action: 'show-result', args: grid })
  assert.equal(state.opened.length, 1)
  assert.equal(state.opened[0].title, AI_TAB_TITLE)
  assert.equal(state.grids[0].key, first.key)

  const second = await applyBridgeAction(deps, { id: '2', action: 'show-result', args: grid })
  assert.equal(second.key, first.key)
  assert.equal(state.opened.length, 1)
  assert.deepEqual(state.activated, [first.key])
  assert.equal(state.written.at(-1).content, grid.sql)
})

test('unknown actions are rejected', async () => {
  const { deps } = setup()
  await assert.rejects(
    applyBridgeAction(deps, { id: '1', action: 'drop-database' }),
    /Unknown bridge action/,
  )
})
