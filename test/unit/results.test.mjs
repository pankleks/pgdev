import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { reactive } from 'vue'

// Execute the real composable with Vue reactivity and controllable API replies.
// No source copies or platform-dependent dynamic import paths are required.
const source = readFileSync(new URL('../../web/src/composables/results.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '')
function setup() {
  const api = {}
  const useResults = new Function('reactive', 'api', `${compiled}; return useResults`)(reactive, api)
  return { api, results: useResults() }
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
  const loading = results.loadAll('tab', 'db')
  results.selectGrid('tab', r.grids[0].key)
  page.resolve({ rows: [[21]], truncated: false })
  assert.equal(await loading, true)
  assert.deepEqual(r.grid.rows, [[1]])
  assert.deepEqual(r.grids[1].rows, [[20], [21]])
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
