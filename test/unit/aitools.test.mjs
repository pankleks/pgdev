import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceLoader } from '../lib/load.mjs'

const load = sourceLoader()
const { createAiTools, DEFAULT_AI_LIMITS } = await load('server/ai/tools.ts')
const { createBridge } = await load('server/ai/bridge.ts')

// Tool layer with everything injected: no pool, no Fastify, no SSE server.
// The assertions pin the agent-visible contract — read-only refusal, row/byte
// caps, and the bridge tools' behaviour with and without a window.

const schema = () => ({
  tables: [
    {
      schema: 'public',
      name: 'items',
      oid: '1',
      columns: [
        { name: 'id', type: 'integer', nullable: false, defaultValue: "nextval('items_id_seq')" },
        { name: 'label', type: 'text', nullable: true, defaultValue: null },
      ],
      indexes: [],
      constraints: [],
      triggers: [],
      isPartition: false,
      isPartitioned: false,
      parents: '',
      relkind: 'r',
    },
  ],
  views: [],
  functions: [
    {
      schema: 'public',
      name: 'item_count',
      args: '',
      returns: 'integer',
      typeSig: '',
      kind: 'function',
      oid: '9',
      arguments: '',
      comment: 'Counts all items.',
    },
  ],
  types: [],
})

function dataResult(rows, extra = {}) {
  return {
    kind: 'ok',
    results: [
      {
        kind: 'data',
        columns: ['id'],
        columnTypes: ['integer'],
        rows,
        rowCount: rows.length,
        truncated: false,
        limited: false,
        ...extra,
      },
    ],
    durationMs: 1,
    transactionOpen: false,
  }
}

function setup(overrides = {}) {
  const {
    bridge: suppliedBridge,
    context = {
      connectionId: 'conn-1',
      connectionLabel: 'local',
      activeKey: 'query-1',
      tabs: [],
    },
    autoContext = true,
    subscribeWindow = suppliedBridge === undefined,
    ...depOverrides
  } = overrides
  const calls = { run: [], ddl: [], schema: [] }
  const bridge = suppliedBridge ?? createBridge(200)
  const deps = {
    connectionIds: () => ['conn-1'],
    getSchema: async (id) => {
      calls.schema.push(id)
      return schema()
    },
    getDdl: async (id, target) => {
      calls.ddl.push([id, target])
      return 'CREATE TABLE items (id integer);'
    },
    runReadOnly: async (id, sql, maxRows) => {
      calls.run.push([id, sql, maxRows])
      return dataResult([[1], [2]])
    },
    bridge,
    ...depOverrides,
  }
  const tools = createAiTools(deps)
  const events = []
  const unsubscribe = subscribeWindow
    ? bridge.subscribe((event) => {
        const parsed = JSON.parse(event)
        if (autoContext && parsed.action === 'get-context') {
          bridge.resolve(parsed.id, context)
          return
        }
        events.push(parsed)
      })
    : () => undefined
  return { tools, calls, events, bridge, unsubscribe }
}

/** Wait for the next bridge action, then answer it. */
async function answer(bridge, events, payload, error = null) {
  for (let i = 0; i < 100 && !events.length; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  const event = events.shift()
  assert.ok(event, 'expected a bridge action')
  bridge.resolve(event.id, payload, error)
  return event
}

test('a write is refused before it reaches the database', async () => {
  const { tools, calls } = setup()
  const result = await tools.query({ sql: 'INSERT INTO items (label) VALUES (\'x\')' })
  assert.equal(result.ok, false)
  assert.match(result.error, /read-only/)
  // The refusal tells the agent where the write belongs instead.
  assert.match(result.error, /set_active_query or open_query_tab/)
  assert.equal(calls.run.length, 0)
})

test('a read runs with the configured row limit and returns the rows', async () => {
  const { tools, calls, events, unsubscribe } = setup()
  const result = await tools.query({ sql: 'SELECT id FROM items' })
  assert.equal(result.ok, true)
  assert.deepEqual(calls.run[0], ['conn-1', 'SELECT id FROM items', DEFAULT_AI_LIMITS.maxRows])
  assert.deepEqual(result.result.results[0].rows, [[1], [2]])
  assert.deepEqual(result.result.results[0].columns, ['id'])
  assert.equal(events[0].action, 'show-result')
  assert.equal(events[0].args.connectionId, 'conn-1')
  unsubscribe()
})

test('rows are capped by count and by bytes', async () => {
  const many = Array.from({ length: 500 }, (_, i) => [i])
  const byCount = setup({ runReadOnly: async () => dataResult(many) })
  const capped = await byCount.tools.query({ sql: 'SELECT id FROM items' })
  assert.equal(capped.ok, true)
  assert.equal(capped.result.results[0].rows.length, DEFAULT_AI_LIMITS.maxRows)
  assert.equal(capped.result.results[0].truncated, true)

  const byBytes = setup({
    limits: { maxRows: 1000, maxBytes: 30 },
    runReadOnly: async () => dataResult([['aaaaaaaaaaaaaaa'], ['bbbbbbbbbbbbbbb'], ['ccccccccccccccc']]),
  })
  const small = await byBytes.tools.query({ sql: 'SELECT id FROM items' })
  assert.equal(small.ok, true)
  assert.equal(small.result.results[0].truncated, true)
  assert.ok(small.result.results[0].rows.length < 3)
})

test('a database read-only error is reported verbatim', async () => {
  const { tools } = setup({
    runReadOnly: async () => ({
      kind: 'error',
      error: { kind: 'sql', message: 'cannot execute INSERT in a read-only transaction', position: null, code: '25006' },
    }),
  })
  const result = await tools.query({ sql: 'WITH x AS (SELECT 1) SELECT * FROM x' })
  assert.equal(result.ok, false)
  assert.match(result.error, /read-only transaction/)
})

test('get_schema filters and carries comments', async () => {
  const { tools } = setup()
  const result = await tools.get_schema({})
  assert.equal(result.ok, true)
  assert.equal(result.result.tables[0].name, 'items')
  assert.equal(result.result.tables[0].columns[1].type, 'text')
  assert.equal(result.result.functions[0].comment, 'Counts all items.')
  assert.equal(result.result.truncated, false)

  const none = await tools.get_schema({ table: 'missing' })
  assert.deepEqual(none.result.tables, [])
  assert.deepEqual(none.result.functions, [])
})

test('get_ddl validates the type and forwards the target', async () => {
  const { tools, calls } = setup()
  const bad = await tools.get_ddl({ type: 'sequence', schema: 'public', name: 's' })
  assert.equal(bad.ok, false)
  assert.match(bad.error, /"type" must be one of/)

  const ok = await tools.get_ddl({ type: 'table', schema: 'public', name: 'items', oid: '1' })
  assert.equal(ok.ok, true)
  assert.equal(ok.result.ddl, 'CREATE TABLE items (id integer);')
  assert.deepEqual(calls.ddl[0], ['conn-1', { type: 'table', schema: 'public', name: 'items', oid: '1', parent: undefined }])
})

test('editor tools report a missing window instead of hanging', async () => {
  const { tools } = setup({ bridge: createBridge(20) })
  for (const result of [
    await tools.get_active_query({}),
    await tools.set_active_query({ sql: 'SELECT 1' }),
    await tools.open_query_tab({ sql: 'SELECT 1' }),
  ]) {
    assert.equal(result.ok, false)
    assert.match(result.error, /No pgDEV window/)
  }
})

test('set_active_query forwards the mode and returns the browser answer', async () => {
  const { tools, events, bridge, unsubscribe } = setup()
  const pending = tools.set_active_query({ sql: 'SELECT 1', mode: 'append' })
  const event = await answer(bridge, events, { sql: 'SELECT 1' })
  assert.equal(event.action, 'set-active-query')
  assert.deepEqual(event.args, { sql: 'SELECT 1', mode: 'append' })
  assert.deepEqual(await pending, { ok: true, result: { sql: 'SELECT 1' } })
  unsubscribe()
})

test('open_query_tab without a title never joins the mirror pool', async () => {
  const { tools, bridge, events, unsubscribe } = setup()
  const pending = tools.open_query_tab({ sql: 'SELECT 1' })
  const event = await answer(bridge, events, { key: 'sql-2', title: 'Agent SQL' })
  assert.equal(event.action, 'open-query-tab')
  assert.equal(event.args.title, 'Agent SQL')
  assert.deepEqual(await pending, { ok: true, result: { key: 'sql-2', title: 'Agent SQL' } })
  unsubscribe()
})

test('two listening windows refuse editor tools and skip the result mirror', async () => {
  const { tools, bridge, events, unsubscribe } = setup()
  const secondEvents = []
  const unsubscribeSecond = bridge.subscribe((event) => secondEvents.push(JSON.parse(event)))

  const active = await tools.get_active_query({})
  assert.equal(active.ok, false)
  assert.match(active.error, /Close the extra ones/)

  const saved = await tools.set_active_query({ sql: 'SELECT 1' })
  assert.equal(saved.ok, false)
  assert.match(saved.error, /2 pgDEV windows/)

  const opened = await tools.open_query_tab({ sql: 'SELECT 1' })
  assert.equal(opened.ok, false)
  assert.match(opened.error, /2 pgDEV windows/)
  assert.deepEqual(events, [])
  assert.deepEqual(secondEvents, [])

  // A database read does not need a window; it just is not mirrored anywhere.
  const read = await tools.query({ sql: 'SELECT 1' })
  assert.equal(read.ok, true)
  assert.equal(read.result.shown, false)

  unsubscribeSecond()
  unsubscribe()
})

test('get_active_result forwards the limits and caps each result set', async () => {
  const { tools, bridge, events, unsubscribe } = setup()
  const pending = tools.get_active_result({})
  const event = await answer(bridge, events, {
    tab: { key: 'query-1', title: 'Query 1', readOnly: false },
    ran: true,
    running: false,
    transactionOpen: true,
    selected: 1,
    messages: [
      { level: 'info', text: '2 statement(s) in 4 ms' },
      { level: 'error', text: 'division by zero' },
    ],
    results: [
      {
        statement: 1,
        columns: ['id'],
        columnTypes: ['integer'],
        rows: [[1], [2], [3]],
        rowCount: 3,
        truncated: false,
        limited: false,
      },
    ],
  })
  assert.equal(event.action, 'get-active-result')
  // The agent's own limit travels with the action so the page can trim early.
  assert.deepEqual(event.args, { maxRows: 100, maxBytes: 64 * 1024 })

  const result = await pending
  assert.equal(result.ok, true)
  assert.equal(result.result.transactionOpen, true)
  assert.equal(result.result.ran, true)
  assert.equal(result.result.messages.at(-1).level, 'error')
  assert.deepEqual(result.result.results[0].rows, [[1], [2], [3]])
  assert.equal(result.result.results[0].truncated, false)
  unsubscribe()
})

test('get_active_result applies the configured limits it was given', async () => {
  const limits = { maxRows: 2, maxBytes: 1024 }
  const { tools, bridge, events, unsubscribe } = setup({ limits })
  const pending = tools.get_active_result({})
  const event = await answer(bridge, events, {
    tab: { key: 'query-1', title: 'Query 1', readOnly: false },
    ran: true,
    running: false,
    transactionOpen: false,
    selected: 1,
    messages: [],
    results: [
      {
        statement: 1,
        columns: ['id'],
        columnTypes: ['integer'],
        rows: [[1], [2], [3]],
        rowCount: 3,
        truncated: false,
        limited: false,
      },
    ],
  })
  assert.deepEqual(event.args, limits)
  const result = await pending
  assert.deepEqual(result.result.results[0].rows, [[1], [2]])
  assert.equal(result.result.results[0].truncated, true)
  unsubscribe()
})

test('get_active_result needs exactly one window', async () => {
  const { tools } = setup({ bridge: createBridge(20) })
  const missing = await tools.get_active_result({})
  assert.equal(missing.ok, false)
  assert.match(missing.error, /No pgDEV window/)

  const { tools: two, bridge, unsubscribe } = setup()
  const second = bridge.subscribe(() => undefined)
  const refused = await two.get_active_result({})
  assert.equal(refused.ok, false)
  assert.match(refused.error, /2 pgDEV windows/)
  second()
  unsubscribe()
})

test('a listening disconnected window never falls back to a sole pool', async () => {
  const { tools, calls, bridge, events, unsubscribe } = setup({ autoContext: false })
  const pending = tools.query({ sql: 'SELECT 1' })
  await answer(bridge, events, {
    connectionId: null,
    connectionLabel: '',
    activeKey: 'query-1',
    tabs: [],
  })
  const result = await pending
  assert.equal(result.ok, false)
  assert.match(result.error, /not connected to a database/i)
  assert.deepEqual(calls.run, [])
  unsubscribe()
})

test('a listening-window context failure is not hidden by pool fallback', async () => {
  const { tools, calls, bridge, events, unsubscribe } = setup({ autoContext: false })
  const pending = tools.query({ sql: 'SELECT 1' })
  await answer(bridge, events, {}, 'The pgDEV window did not answer in time.')
  const result = await pending
  assert.equal(result.ok, false)
  assert.match(result.error, /did not answer in time/)
  assert.deepEqual(calls.run, [])
  unsubscribe()
})

test('the agent can never run the editor, and never picks a connection', async () => {
  const { tools, calls } = setup()
  assert.deepEqual(Object.keys(tools).sort(), [
    'get_active_query',
    'get_active_result',
    'get_ddl',
    'get_schema',
    'open_query_tab',
    'query',
    'set_active_query',
  ])

  // The connection is whatever pgDEV has open; an argument cannot redirect it.
  const read = await tools.query({ sql: 'SELECT 1', connection: 'other' })
  assert.equal(read.ok, true)
  assert.deepEqual(calls.run[0], ['conn-1', 'SELECT 1', 100])
})

test('without a connection every database tool says so', async () => {
  const { tools } = setup({ connectionIds: () => [] })
  for (const result of [
    await tools.query({ sql: 'SELECT 1' }),
    await tools.get_schema({}),
    await tools.get_ddl({ type: 'table', schema: 'public', name: 'items' }),
  ]) {
    assert.equal(result.ok, false)
    assert.match(result.error, /not connected to a database/i)
  }
})

test('the connection open in the window wins over ambiguous pools', async () => {
  // No window and several pools: nothing to choose the working connection by.
  const silent = setup({ bridge: createBridge(20), connectionIds: () => ['conn-1', 'conn-2'] })
  const ambiguous = await silent.tools.query({ sql: 'SELECT 1' })
  assert.equal(ambiguous.ok, false)
  assert.match(ambiguous.error, /2 connections open/)

  // A listening window names the one in use.
  const { tools, calls, bridge, events, unsubscribe } = setup({
    connectionIds: () => ['conn-1', 'conn-2'],
    autoContext: false,
  })
  const pending = tools.query({ sql: 'SELECT 1' })
  const event = await answer(bridge, events, {
    connectionId: 'conn-2',
    connectionLabel: 'qa',
    activeKey: 'query-1',
    tabs: [],
  })
  assert.equal(event.action, 'get-context')
  assert.equal((await pending).ok, true)
  assert.deepEqual(calls.run[0], ['conn-2', 'SELECT 1', 100])
  unsubscribe()
})
