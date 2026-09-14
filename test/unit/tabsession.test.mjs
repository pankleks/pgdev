import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceLoader } from '../lib/load.mjs'

const load = sourceLoader()
const { serializeSession, restoreSession, sanitizeSession } = await load('web/lib/tabsession.ts')

// The session covers user-created query tabs only: DDL tabs, generated SQL,
// file tabs and pins are never saved, and restoring always yields fresh
// unsaved query tabs.

const tab = (key, over = {}) => ({
  key,
  kind: 'query',
  source: 'untitled',
  title: key,
  fileName: null,
  content: '',
  savedContent: null,
  readOnly: false,
  ...over,
})

test('serializeSession keeps only persisted user tabs, in order', () => {
  const session = serializeSession(
    [
      tab('query-1', { persist: true, content: 'select 1' }),
      tab('ddl-table-public-t--ab12cd34', { kind: 'ddl', savedContent: 'create table …' }),
      tab('file-2', { source: 'file', fileName: 'a.sql' }),
      tab('sql-3', { content: 'alter table t add column c int' }),
      tab('query-4', { persist: true, title: 'Query 4', content: 'select 2' }),
    ],
    'query-4',
  )
  assert.deepEqual(session.tabs.map((t) => t.key), ['query-1', 'query-4'])
  assert.equal(session.activeIndex, 1)
  assert.equal(session.tabs[0].content, 'select 1')
  assert.equal(session.tabs[1].title, 'Query 4')
})

test('serializeSession falls back to the first tab when the active one is not saved', () => {
  const saved = tab('query-1', { persist: true })
  const notSaved = tab('ddl-x', { kind: 'ddl' })
  assert.equal(serializeSession([saved, notSaved], 'ddl-x').activeIndex, 0)
  assert.deepEqual(serializeSession([notSaved], 'ddl-x'), { tabs: [], activeIndex: 0 })
})

test('restoreSession rebuilds fresh, unsaved query tabs', () => {
  let n = 7
  const restored = restoreSession(
    {
      tabs: [
        { key: 'query-1', title: 'Query 1', content: 'select 1' },
        { key: 'query-2', title: 'Query 2', content: 'select 2' },
      ],
      activeIndex: 1,
    },
    () => `query-${n++}`,
  )
  assert.deepEqual(restored.map((t) => t.key), ['query-7', 'query-8'])
  assert.deepEqual(restored.map((t) => t.title), ['Query 1', 'Query 2'])
  assert.deepEqual(restored.map((t) => t.content), ['select 1', 'select 2'])
  for (const t of restored) {
    assert.equal(t.persist, true)
    assert.equal(t.kind, 'query')
    assert.equal(t.source, 'untitled')
    assert.equal(t.savedContent, null)
    assert.equal(t.fileName, null)
    assert.equal(t.readOnly, false)
  }
})

test('sanitizeSession rejects unusable records and filters malformed tabs', () => {
  assert.equal(sanitizeSession(null), null)
  assert.equal(sanitizeSession('nope'), null)
  assert.equal(sanitizeSession({}), null)
  assert.equal(sanitizeSession({ tabs: 'not an array' }), null)
  assert.deepEqual(sanitizeSession({ tabs: [] }), { tabs: [], activeIndex: 0 })

  const clean = sanitizeSession({
    tabs: [
      { key: 'a', title: 'A', content: 'x' },
      { key: 1, title: 'B', content: 'y' },
      null,
      { key: 'c', title: 'C' },
      { key: 'd', title: 'D', content: 42 },
    ],
    activeIndex: 99,
  })
  assert.deepEqual(clean, {
    tabs: [
      { key: 'a', title: 'A', content: 'x' },
      { key: 'c', title: 'C', content: '' },
    ],
    activeIndex: 1,
  })
})

test('sanitizeSession clamps or defaults the active index', () => {
  const tabs = [
    { key: 'a', title: 'A', content: '' },
    { key: 'b', title: 'B', content: '' },
  ]
  assert.equal(sanitizeSession({ tabs, activeIndex: -1 }).activeIndex, 0)
  assert.equal(sanitizeSession({ tabs, activeIndex: 1.5 }).activeIndex, 0)
  assert.equal(sanitizeSession({ tabs }).activeIndex, 0)
})
