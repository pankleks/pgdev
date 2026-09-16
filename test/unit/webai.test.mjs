import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceLoader } from '../lib/load.mjs'

const load = sourceLoader()
const { applyBridgeAction, AI_TAB_TITLE } = await load('web/lib/aibridge.ts')

// The browser's half of the AI bridge, pure over injected stores.

function setup(overrides = {}) {
  const tabs = [
    { key: 'query-1', title: 'Query 1', readOnly: false, content: 'SELECT 1', connectionId: 'conn-1' },
    { key: 'ddl-1', title: 'items', readOnly: true, content: 'CREATE TABLE items ();', connectionId: 'conn-1' },
  ]
  const state = {
    activeKey: 'query-1',
    fallback: tabs[1],
    written: [],
    opened: [],
    grids: [],
    activated: [],
    inserted: [],
    results: {},
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
      tabs.push({ key, title, readOnly: false, content, connectionId })
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
    activeResult: (key) => state.results[key] ?? null,
    ...overrides,
  }
  return { deps, state, tabs }
}

function grid(overrides = {}) {
  return {
    statement: 1,
    columns: ['id'],
    columnTypes: ['integer'],
    rows: [[1], [2]],
    rowCount: 2,
    truncated: false,
    limited: false,
    ...overrides,
  }
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

test('get-active-result reports the tab and nothing ran yet', async () => {
  const { deps } = setup()
  const result = await applyBridgeAction(deps, { id: '1', action: 'get-active-result' })
  assert.equal(result.tab.key, 'query-1')
  assert.equal(result.tab.title, 'Query 1')
  assert.equal(result.ran, false)
  assert.equal(result.running, false)
  assert.equal(result.transactionOpen, false)
  assert.equal(result.selected, null)
  assert.deepEqual(result.messages, [])
  assert.deepEqual(result.results, [])
})

test('get-active-result returns every result set with its messages', async () => {
  const { deps, state } = setup()
  state.results['query-1'] = {
    running: false,
    transactionOpen: true,
    selected: 2,
    messages: [
      { level: 'info', text: '2 statement(s) in 4 ms' },
      { level: 'info', text: 'Statement 1: 2 row(s)' },
      { level: 'error', text: 'Statement 2: division by zero' },
    ],
    grids: [grid(), grid({ statement: 2, columns: ['x'], rows: [[3]], rowCount: 1 })],
  }
  const result = await applyBridgeAction(deps, { id: '1', action: 'get-active-result' })
  assert.equal(result.ran, true)
  assert.equal(result.transactionOpen, true)
  assert.equal(result.selected, 2)
  assert.deepEqual(result.messages.at(-1), { level: 'error', text: 'Statement 2: division by zero' })
  assert.deepEqual(result.results.map((r) => r.rows), [[[1], [2]], [[3]]])
  assert.ok(result.results.every((r) => r.truncated === false))
})

test('get-active-result trims to the cap the server asked for', async () => {
  const { deps, state } = setup()
  state.results['query-1'] = {
    running: true,
    transactionOpen: false,
    selected: 1,
    messages: [],
    grids: [grid({ rows: [[1], [2], [3], [4]], rowCount: 4 })],
  }
  const limited = await applyBridgeAction(deps, {
    id: '1',
    action: 'get-active-result',
    args: { maxRows: 2, maxBytes: 1024 },
  })
  assert.deepEqual(limited.results[0].rows, [[1], [2]])
  assert.equal(limited.results[0].truncated, true)
  assert.equal(limited.running, true)

  // A byte budget stops the payload from growing without bound.
  const tight = await applyBridgeAction(deps, {
    id: '2',
    action: 'get-active-result',
    args: { maxRows: 100, maxBytes: 5 },
  })
  assert.deepEqual(tight.results[0].rows, [[1]])
  assert.equal(tight.results[0].truncated, true)
})

test('get-active-result needs a tab', async () => {
  const { deps, state } = setup()
  state.activeKey = 'gone'
  await assert.rejects(
    applyBridgeAction(deps, { id: '1', action: 'get-active-result' }),
    /No tab is open/,
  )
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
    connectionId: 'conn-1',
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

test('show-result keeps the result bound to its source connection', async () => {
  const { deps, state, tabs } = setup()
  tabs.push({
    key: 'ai-other',
    title: AI_TAB_TITLE,
    readOnly: false,
    content: 'SELECT from_other_connection',
    connectionId: 'conn-2',
  })
  const shown = await applyBridgeAction(deps, {
    id: '1',
    action: 'show-result',
    args: {
      connectionId: 'conn-1',
      sql: 'SELECT from_conn_1',
      columns: ['id'],
      columnTypes: ['integer'],
      rows: [[1]],
      rowCount: 1,
      truncated: false,
    },
  })
  assert.equal(state.opened.length, 1)
  assert.equal(state.opened[0].connectionId, 'conn-1')
  assert.notEqual(shown.key, 'ai-other')
  assert.deepEqual(state.activated, [])
})

test('show-result opens another tab instead of invalidating busy AI work', async () => {
  for (const resultState of [
    { running: true, transactionOpen: false },
    { running: false, transactionOpen: true },
  ]) {
    const { deps, state, tabs } = setup()
    tabs.push({
      key: 'ai-busy',
      title: AI_TAB_TITLE,
      readOnly: false,
      content: 'SELECT busy',
      connectionId: 'conn-1',
    })
    state.results['ai-busy'] = {
      running: resultState.running,
      transactionOpen: resultState.transactionOpen,
      selected: 1,
      messages: [],
      grids: [],
    }
    const shown = await applyBridgeAction(deps, {
      id: '1',
      action: 'show-result',
      args: {
        connectionId: 'conn-1',
        sql: 'SELECT replacement',
        columns: ['id'],
        columnTypes: ['integer'],
        rows: [[1]],
        rowCount: 1,
        truncated: false,
      },
    })
    assert.equal(state.opened.length, 1)
    assert.equal(shown.key, state.opened[0].key)
    assert.notEqual(shown.key, 'ai-busy')
  }
})

test('unknown actions are rejected', async () => {
  const { deps } = setup()
  await assert.rejects(
    applyBridgeAction(deps, { id: '1', action: 'drop-database' }),
    /Unknown bridge action/,
  )
})
