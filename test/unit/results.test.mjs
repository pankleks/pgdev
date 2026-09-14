import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceLoader } from '../lib/load.mjs'

// Execute the real composable with Vue reactivity and a controllable API
// injected through the createResults factory — no source rewriting.
const load = sourceLoader()
const { createResults } = await load('web/composables/results.ts')

function setup() {
  const api = {}
  return { api, results: createResults(api) }
}
const data = (name, rows, extra = {}) => ({
  kind: 'data', columns: [name], columnTypes: ['integer'], rows,
  rowCount: rows.length, truncated: false, ...extra,
})
function deferred() {
  let resolve
  const promise = new Promise(r => { resolve = r })
  return { promise, resolve }
}

test('retains every result, including empty results and original statement numbers', async () => {
  const { api, results } = setup()
  api.query = async () => ({ durationMs: 1, results: [
    data('customers', [[1]], { limited: true, totalRowCount: 10 }),
    { kind: 'command', command: 'UPDATE', rowCount: 1 },
    data('empty', []), data('orders', [[2]], { truncated: true }),
  ] })
  await results.run('tab', 'db', 'batch')
  const r = results.state.byTab.tab
  assert.deepEqual(r.grids.map(g => g.statementNumber), [1, 3, 4])
  assert.equal(new Set(r.grids.map(g => g.key)).size, 3)
  assert.equal(r.grid, r.grids[0])
  for (const grid of r.grids) {
    r.showMessages = true
    results.selectGrid('tab', grid.key)
    assert.equal(r.grid, grid)
    assert.equal(r.showMessages, false)
  }
  results.selectGrid('tab', 'missing')
  assert.equal(r.grid, r.grids[2])
  assert.ok(r.messages.some(m => m.text.includes('UPDATE: 1')))
  assert.ok(r.messages.some(m => m.text.includes('remaining rows were not retained')))
})

test('a page arriving after selection changes updates only its original result', async () => {
  const { api, results } = setup()
  api.query = async () => ({ durationMs: 1, results: [data('a', [[1]]), data('b', [[20]], { truncated: true })] })
  await results.run('tab', 'db', 'batch')
  const r = results.state.byTab.tab
  let calls = 0
  const page = deferred()
  api.fetchMore = () => { calls++; return page.promise }
  await results.loadMore('tab', 'db')
  assert.equal(calls, 0, 'non-pageable results cannot request rows')
  results.selectGrid('tab', r.grids[1].key)
  const loading = results.loadMore('tab', 'db')
  results.selectGrid('tab', r.grids[0].key)
  page.resolve({ rows: [[21]], truncated: false })
  await loading
  assert.deepEqual(r.grid.rows, [[1]])
  assert.deepEqual(r.grids[1].rows, [[20], [21]])
  assert.equal(r.grids[1].rowCount, 2)
  assert.equal(r.grids[1].truncated, false)
  assert.equal(r.loadingMore, false)
})

test('export draining retains its target across result switches', async () => {
  const { api, results } = setup()
  api.query = async () => ({ durationMs: 1, results: [data('a', [[1]]), data('b', [[20]], { truncated: true })] })
  await results.run('tab', 'db', 'batch')
  const r = results.state.byTab.tab
  const page = deferred()
  api.fetchMore = () => page.promise
  results.selectGrid('tab', r.grids[1].key)
  const loading = results.loadAll('tab', 'db', r.grids[1])
  results.selectGrid('tab', r.grids[0].key)
  page.resolve({ rows: [[21]], truncated: false })
  assert.equal(await loading, true)
  assert.deepEqual(r.grid.rows, [[1]])
  assert.deepEqual(r.grids[1].rows, [[20], [21]])
})

test('streaming export drains into the sink without retaining pages', async () => {
  const { api, results } = setup()
  api.query = async () => ({ durationMs: 1, results: [data('a', [[1]], { truncated: true })] })
  await results.run('tab', 'db', 'q')
  const r = results.state.byTab.tab
  const g = r.grid
  let calls = 0
  api.fetchMore = async () => {
    calls++
    return calls === 1 ? { rows: [[2], [3]], truncated: true } : { rows: [[4]], truncated: false }
  }
  const pages = []
  const complete = await results.exportAll('tab', 'db', g, (rows) => { pages.push(...rows) }, false)
  assert.equal(complete, true)
  assert.deepEqual(pages, [[1], [2], [3], [4]], 'every page reached the sink')
  assert.deepEqual(g.rows, [[1]], 'drained pages are not retained in the grid')
  assert.equal(g.truncated, false)
  assert.deepEqual(g.exported, { rows: 4 })
  assert.equal(r.loadingMore, false)
  // The cursor is consumed: Load more must not touch the API again.
  await results.loadMore('tab', 'db')
  assert.equal(calls, 2)
})

test('export writes to the captured grid, not the current selection', async () => {
  const { api, results } = setup()
  api.query = async () => ({
    durationMs: 1,
    results: [data('a', [[1]], { truncated: true }), data('b', [[9]], { truncated: true })],
  })
  await results.run('tab', 'db', 'batch')
  const r = results.state.byTab.tab
  const captured = r.grids[0]
  // The user switches sub-tabs while the save picker is open: the export must
  // still drain the grid it was started from.
  results.selectGrid('tab', r.grids[1].key)
  api.fetchMore = async () => ({ rows: [[2]], truncated: false })
  const sink = []
  const complete = await results.exportAll('tab', 'db', captured, (rows) => { sink.push(...rows) }, false)
  assert.equal(complete, true)
  assert.deepEqual(sink, [[1], [2]])
  assert.deepEqual(captured.exported, { rows: 2 })
  assert.equal(r.grids[1].exported, undefined)
})

test('a streaming export aborts when the result is dropped mid-drain', async () => {
  const { api, results } = setup()
  api.query = async () => ({ durationMs: 1, results: [data('a', [[1]], { truncated: true })] })
  await results.run('tab', 'db', 'q')
  const g = results.state.byTab.tab.grid
  const page = deferred()
  api.fetchMore = () => page.promise
  const sink = []
  const exporting = results.exportAll('tab', 'db', g, (rows) => { sink.push(...rows) }, false)
  results.drop('tab')
  page.resolve({ rows: [[2]], truncated: false })
  assert.equal(await exporting, false)
  assert.deepEqual(sink, [[1]], 'the page arriving after the drop is discarded')
  assert.equal(g.exported, undefined)
})

test('dropped results ignore outstanding pages and new runs replace all grids', async () => {
  const { api, results } = setup()
  api.query = async () => ({ durationMs: 1, results: [data('a', [[1]]), data('b', [[20]], { truncated: true })] })
  await results.run('tab', 'db', 'batch')
  const old = results.state.byTab.tab
  results.selectGrid('tab', old.grids[1].key)
  const page = deferred()
  api.fetchMore = () => page.promise
  const loading = results.loadMore('tab', 'db')
  results.drop('tab')
  api.query = async () => ({ durationMs: 1, results: [data('new', [[99]])] })
  await results.run('tab', 'db', 'new')
  page.resolve({ rows: [[21]], truncated: false })
  await loading
  assert.equal(results.state.byTab.tab.grids.length, 1)
  assert.deepEqual(results.state.byTab.tab.grid.rows, [[99]])
  assert.deepEqual(old.grids[1].rows, [[20]])
  api.query = async () => { throw new Error('SQL error') }
  await results.run('tab', 'db', 'error')
  assert.deepEqual(results.state.byTab.tab.grids, [])
  assert.equal(results.state.byTab.tab.grid, null)
  assert.equal(results.state.byTab.tab.showMessages, true)
})

test('command-only runs show Messages and selections are independent across editor tabs', async () => {
  const { api, results } = setup()
  api.query = async () => ({ durationMs: 1, results: [data('a', [[1]]), data('b', [[2]])] })
  await results.run('one', 'db', 'batch')
  await results.run('two', 'db', 'batch')
  results.selectGrid('one', results.state.byTab.one.grids[1].key)
  assert.equal(results.state.byTab.two.grid, results.state.byTab.two.grids[0])
  api.query = async () => ({ durationMs: 1, results: [{ kind: 'command', command: 'UPDATE', rowCount: 5 }] })
  await results.run('one', 'db', 'update')
  assert.deepEqual(results.state.byTab.one.grids, [])
  assert.equal(results.state.byTab.one.showMessages, true)
  assert.equal(results.state.byTab.two.grids.length, 2)
})
