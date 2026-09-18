import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceLoader } from '../lib/load.mjs'

const load = sourceLoader()
const { applyBridgeAction, AI_TAB_TITLE } = await load('web/lib/aibridge.ts')

// The browser's half of the AI bridge, pure over injected stores.

function setup(overrides = {}) {
  const tabs = [
    { key: 'query-1', kind: 'query', title: 'Query 1', readOnly: false, content: 'SELECT 1', connectionId: 'conn-1' },
    { key: 'ddl-1', kind: 'ddl', title: 'items', readOnly: true, content: 'CREATE TABLE items ();', connectionId: 'conn-1' },
  ]
  const state = {
    activeKey: 'query-1',
    fallback: tabs[1],
    written: [],
    opened: [],
    grids: [],
    activated: [],
    inserted: [],
    closed: [],
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
      // The real composable marks bridge-opened tabs; the table editor's tabs
      // stay unmarked.
      tabs.push({ key, kind: 'query', title, readOnly: false, content, connectionId, agentOpened: true, dirty: false })
      state.activeKey = key
      state.opened.push({ key, title, content, connectionId })
    },
    showAiLog: (entry) => {
      const existing = tabs.find((t) => t.aiMirror === true)
      if (existing) {
        existing.content = existing.content.trim()
          ? `${existing.content.replace(/\s+$/, '')}\n\n${entry}`
          : entry
        state.activeKey = existing.key
        return existing.key
      }
      const key = 'ai-log'
      tabs.push({ key, kind: 'query', title: AI_TAB_TITLE, readOnly: true, content: entry, aiMirror: true, dirty: false })
      state.activeKey = key
      state.opened.push({ key, title: AI_TAB_TITLE, content: entry, aiMirror: true })
      return key
    },
    updateContent: (key, content) => {
      const tab = tabs.find((t) => t.key === key)
      if (tab) tab.content = content
      state.written.push({ key, content })
    },
    showGrid: (key, grid) => {
      state.grids.push({ key, grid })
      return true
    },
    insertAtCursor: (sql) => {
      state.inserted.push(sql)
      return true
    },
    activeResult: (key) => state.results[key] ?? null,
    closeTab: (key) => {
      const index = tabs.findIndex((t) => t.key === key)
      if (index === -1) return
      tabs.splice(index, 1)
      state.closed.push(key)
      if (state.activeKey === key) {
        const next = tabs[Math.min(index, tabs.length - 1)]
        state.activeKey = next?.key ?? ''
      }
    },
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
  await assert.rejects(
    applyBridgeAction(deps, { id: '2', action: 'drop-database' }),
    /Unknown bridge action/,
  )
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
  const { deps, state } = setup()
  const result = await applyBridgeAction(deps, { id: '1', action: 'get-active-result' })
  assert.equal(result.tab.key, 'query-1')
  assert.equal(result.tab.title, 'Query 1')
  assert.equal(result.ran, false)
  assert.equal(result.running, false)
  assert.equal(result.transactionOpen, false)
  assert.equal(result.selected, null)
  assert.deepEqual(result.messages, [])
  assert.deepEqual(result.results, [])

  state.activeKey = 'gone'
  await assert.rejects(
    applyBridgeAction(deps, { id: '2', action: 'get-active-result' }),
    /No tab is open/,
  )
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

  // Without a title the tab still opens but never joins the mirror pool.
  const untitled = await applyBridgeAction(deps, {
    id: '2',
    action: 'open-query-tab',
    args: { sql: 'SELECT 1' },
  })
  assert.notEqual(untitled.title, AI_TAB_TITLE)
})

test('list-tabs shows only agent tabs, with dirty flags', async () => {
  const { deps, state, tabs } = setup()
  state.activeKey = 'query-1'
  // Start with none: user tabs are invisible to the agent.
  assert.deepEqual(await applyBridgeAction(deps, { id: '1', action: 'list-tabs' }), {
    activeKey: 'query-1',
    tabs: [],
  })

  await applyBridgeAction(deps, { id: '2', action: 'open-query-tab', args: { sql: 'SELECT 1', title: 'one' } })
  const mirror = await applyBridgeAction(deps, {
    id: '3',
    action: 'show-result',
    args: { connectionId: 'conn-1', sql: 'SELECT 1', columns: ['id'], columnTypes: [], rows: [[1]], rowCount: 1, truncated: false },
  })
  // The staged tab is clean; the mirror was reused with identical SQL. Mark
  // one dirty by hand: the real flag comes from tabs.isDirty, mapped by the
  // composable and covered end to end in the browser suite.
  tabs.find((t) => t.key === 'sql-2').dirty = true
  const listed = await applyBridgeAction(deps, { id: '4', action: 'list-tabs' })
  assert.equal(listed.activeKey, mirror.key)
  assert.deepEqual(
    listed.tabs.map((t) => [t.key, t.title, t.kind, t.readOnly, t.dirty, t.active]),
    [
      ['sql-2', 'one', 'query', false, true, false],
      [mirror.key, 'AI', 'query', true, false, true],
    ],
  )
})

test('activate-tab switches by key or unique title, never to user tabs', async () => {
  const { deps, state } = setup()
  await applyBridgeAction(deps, { id: '1', action: 'open-query-tab', args: { sql: 'SELECT 1', title: 'one' } })
  const moved = await applyBridgeAction(deps, { id: '2', action: 'activate-tab', args: { tab: 'sql-2' } })
  assert.equal(moved.key, 'sql-2')
  assert.deepEqual(state.activated.at(-1), 'sql-2')

  const byTitle = await applyBridgeAction(deps, { id: '3', action: 'activate-tab', args: { tab: 'one' } })
  assert.equal(byTitle.key, 'sql-2')

  await assert.rejects(
    applyBridgeAction(deps, { id: '4', action: 'activate-tab', args: { tab: 'Query 1' } }),
    /was not opened by the agent/,
  )
  await assert.rejects(
    applyBridgeAction(deps, { id: '5', action: 'activate-tab', args: { tab: '   ' } }),
    /"tab" is required/,
  )
})

test('activate-tab refuses an ambiguous title', async () => {
  const { deps } = setup()
  await applyBridgeAction(deps, { id: '1', action: 'open-query-tab', args: { sql: 'SELECT 1', title: 'dup' } })
  await applyBridgeAction(deps, { id: '2', action: 'open-query-tab', args: { sql: 'SELECT 2', title: 'dup' } })
  await assert.rejects(
    applyBridgeAction(deps, { id: '3', action: 'activate-tab', args: { tab: 'dup' } }),
    /Several agent tabs are titled "dup"/,
  )
})

test('close-tab closes a clean agent tab and reports the new active tab', async () => {
  const { deps, state } = setup()
  await applyBridgeAction(deps, { id: '1', action: 'open-query-tab', args: { sql: 'SELECT 1', title: 'one' } })
  const closed = await applyBridgeAction(deps, { id: '2', action: 'close-tab', args: { tab: 'one' } })
  assert.equal(closed.closed, 'sql-2')
  assert.deepEqual(state.closed, ['sql-2'])
  assert.equal(closed.activeKey, 'ddl-1')
  assert.equal((await applyBridgeAction(deps, { id: '3', action: 'list-tabs' })).tabs.length, 0)
})

test('close-tab refuses foreign and dirty tabs', async () => {
  const { deps, state, tabs } = setup()
  // A user tab, even named like an agent one, is off limits.
  await assert.rejects(
    applyBridgeAction(deps, { id: '1', action: 'close-tab', args: { tab: 'query-1' } }),
    /was not opened by the agent/,
  )
  await assert.rejects(
    applyBridgeAction(deps, { id: '2', action: 'close-tab', args: { tab: 'nope' } }),
    /No agent tab "nope"/,
  )
  assert.deepEqual(state.closed, [])

  // Dirty means modified after staging: only the user can close it.
  await applyBridgeAction(deps, { id: '3', action: 'open-query-tab', args: { sql: 'SELECT 1', title: 'one' } })
  tabs.find((t) => t.key === 'sql-2').dirty = true
  await assert.rejects(
    applyBridgeAction(deps, { id: '4', action: 'close-tab', args: { tab: 'one' } }),
    /has unsaved changes/,
  )
  assert.deepEqual(state.closed, [])
})

test('show-result appends to one read-only AI log and renders the grid', async () => {
  const { deps, state, tabs } = setup()
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
  assert.equal(first.key, 'ai-log')
  assert.equal(state.opened.length, 1)
  assert.equal(state.opened[0].title, AI_TAB_TITLE)
  assert.equal(state.opened[0].aiMirror, true)
  assert.equal(state.grids[0].key, first.key)
  const log = tabs.find((t) => t.aiMirror === true)
  assert.equal(log.readOnly, true)

  const second = await applyBridgeAction(deps, { id: '2', action: 'show-result', args: grid })
  assert.equal(second.key, first.key)
  assert.equal(state.opened.length, 1, 'never a second AI tab')
  assert.equal(state.activeKey, first.key)
  assert.equal(log.content, `${grid.sql}\n\n${grid.sql}`)
})

test('the AI log is reused across connections and never confused with user tabs', async () => {
  const { deps, state, tabs } = setup()
  tabs.push(
    {
      key: 'ai-other',
      kind: 'query',
      title: AI_TAB_TITLE,
      readOnly: true,
      content: 'SELECT from_other_connection',
      connectionId: 'conn-2',
      aiMirror: true,
    },
    // User tabs merely titled AI are invisible to the mirror lookup.
    {
      key: 'query-ai',
      kind: 'query',
      title: AI_TAB_TITLE,
      readOnly: false,
      content: 'SELECT user_staged',
      connectionId: 'conn-1',
    },
    {
      key: 'ddl-ai',
      kind: 'ddl',
      title: AI_TAB_TITLE,
      readOnly: false,
      content: 'CREATE TABLE ai ();',
      connectionId: 'conn-1',
    },
  )
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
  assert.equal(shown.key, 'ai-other')
  assert.equal(state.opened.length, 0, 'an existing log is reused across connections')
  assert.equal(tabs.filter((t) => t.aiMirror === true).length, 1, 'never a second AI tab')
  const log = tabs.find((t) => t.key === 'ai-other')
  assert.equal(log.connectionId, 'conn-2', 'reuse does not rebind it')
  assert.ok(log.content.includes('SELECT from_conn_1'), 'the new SQL joins the log')
  assert.equal(tabs.find((t) => t.key === 'query-ai').content, 'SELECT user_staged')
})

test('show-result refuses when the AI log grid cannot be shown', async () => {
  const { deps } = setup({ showGrid: () => false })
  await assert.rejects(
    applyBridgeAction(deps, {
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
    }),
    /AI log tab is busy/,
  )
})

