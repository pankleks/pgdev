import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceLoader } from '../lib/load.mjs'

const load = sourceLoader()
const { isTabDirty, isSessionTab, serializeSession, restoreSession, sanitizeSession } =
  await load('web/lib/tabsession.ts')

// User-created query tabs are always saved; any other tab joins the session
// once it is dirty, so unsaved edits to a DDL preview, generated SQL or file
// tab survive a restart. Restored tabs keep their kind, and only dirty ones
// keep their baseline so they come back dirty and revertible.

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

test('isTabDirty compares against the baseline, newline-insensitively', () => {
  assert.equal(isTabDirty(tab('q1', { content: '' })), false, 'empty untitled query is clean')
  assert.equal(isTabDirty(tab('q2', { content: 'select 1' })), true, 'non-empty untitled query is dirty')
  // A DDL tab with no baseline is clean; one with a baseline is dirty only
  // when it differs.
  assert.equal(isTabDirty(tab('d1', { kind: 'ddl', content: 'create table t ()' })), false)
  assert.equal(isTabDirty(tab('d2', { kind: 'ddl', savedContent: 'a', content: 'a' })), false)
  assert.equal(isTabDirty(tab('d3', { kind: 'ddl', savedContent: 'a', content: 'b' })), true)
  assert.equal(isTabDirty(tab('q3', { savedContent: 'a\r\nb', content: 'a\nb' })), false)
})

test('a read-only tab is never dirty and never joins the session', () => {
  // The AI log is read-only and accumulates, so its baseline can never match;
  // read-only must win before the content comparison.
  assert.equal(isTabDirty(tab('q1', { readOnly: true, content: 'select 1' })), false)
  assert.equal(isTabDirty(tab('d1', { kind: 'ddl', readOnly: true, savedContent: 'a', content: 'b' })), false)
  assert.equal(isSessionTab(tab('q1', { readOnly: true, content: 'select 1' })), false)
})

test('isSessionTab keeps user query tabs always and others when dirty', () => {
  assert.equal(isSessionTab(tab('q1', { persist: true })), true)
  assert.equal(isSessionTab(tab('q2', { content: 'select 1' })), true)
  assert.equal(isSessionTab(tab('sql-1', { savedContent: 'a', content: 'a' })), false)
  assert.equal(isSessionTab(tab('sql-2', { savedContent: 'a', content: 'b' })), true)
})

test('serializeSession keeps persisted query tabs and dirty others, in order', () => {
  const session = serializeSession(
    [
      tab('query-1', { persist: true, content: 'select 1' }),
      tab('ddl-clean', { kind: 'ddl', savedContent: 'create table t ()', content: 'create table t ()' }),
      tab('ddl-dirty', { kind: 'ddl', savedContent: 'create table t ()', content: 'create table t (id int)' }),
      tab('file-clean', { source: 'file', fileName: 'a.sql', savedContent: 'select 2', content: 'select 2' }),
      tab('sql-clean', { savedContent: 'alter table t add column c int', content: 'alter table t add column c int' }),
      tab('sql-dirty', { savedContent: '', content: 'alter table t add column c int' }),
      tab('sql-agent', { agentOpened: true, savedContent: '', content: 'alter table t drop column c int' }),
      tab('query-5', { persist: true, title: 'Query 5', content: 'select 2' }),
    ],
    'sql-dirty',
  )
  assert.deepEqual(session.tabs.map((t) => t.key), ['query-1', 'ddl-dirty', 'sql-dirty', 'sql-agent', 'query-5'])
  assert.equal(session.activeIndex, 2)
  assert.equal(session.tabs[1].kind, 'ddl')
  assert.equal(session.tabs[1].savedContent, 'create table t ()')
  assert.equal(session.tabs[1].persist, false)
  assert.equal(session.tabs[0].persist, true)
  assert.equal(session.tabs[3].agentOpened, true, 'agent-opened tabs keep their flag')
  assert.equal(session.tabs[0].agentOpened, false)
})

test('serializeSession falls back to the first tab when the active one is not saved', () => {
  const saved = tab('query-1', { persist: true })
  const cleanDdl = tab('ddl-x', { kind: 'ddl', savedContent: 'x', content: 'x' })
  assert.equal(serializeSession([saved, cleanDdl], 'ddl-x').activeIndex, 0)
  assert.deepEqual(serializeSession([cleanDdl], 'ddl-x'), { tabs: [], activeIndex: 0 })
})

test('restoreSession preserves kind, the dirty baseline and the agent flag', () => {
  let n = 7
  const restored = restoreSession(
    {
      tabs: [
        { key: 'query-1', title: 'Query 1', content: 'select 1', kind: 'query', savedContent: null, readOnly: false, persist: true, agentOpened: false },
        { key: 'ddl-x', title: 't', content: 'create t (id int)', kind: 'ddl', savedContent: 'create t ()', readOnly: false, persist: false, agentOpened: false },
        { key: 'sql-agent', title: 'Agent SQL', content: 'select 2', kind: 'query', savedContent: 'select 1', readOnly: false, persist: false, agentOpened: true },
      ],
      activeIndex: 2,
    },
    () => `query-${n++}`,
  )
  assert.deepEqual(restored.map((t) => t.key), ['query-7', 'query-8', 'query-9'])
  assert.deepEqual(restored.map((t) => t.kind), ['query', 'ddl', 'query'])
  // A restored always-saved query tab is unsaved; a dirty tab keeps its
  // baseline so it stays dirty and revertible.
  assert.equal(restored[0].savedContent, null)
  assert.equal(restored[0].persist, true)
  assert.equal(restored[1].savedContent, 'create t ()')
  assert.equal(restored[1].persist, undefined)
  // A tab the agent opened comes back tinted and still agent-owned.
  assert.equal(restored[0].agentOpened, undefined)
  assert.equal(restored[2].agentOpened, true)
  assert.equal(restored[2].savedContent, 'select 1')
  for (const t of restored) {
    assert.equal(t.source, 'untitled')
    assert.equal(t.fileName, null)
    assert.equal(t.readOnly, false)
  }
})

test('sanitizeSession fills defaults for records that predate the new fields', () => {
  // Legacy sessions stored only key/title/content and held query tabs.
  const session = sanitizeSession({
    tabs: [{ key: 'a', title: 'A', content: 'x' }],
    activeIndex: 0,
  })
  assert.deepEqual(session, {
    tabs: [{ key: 'a', title: 'A', content: 'x', kind: 'query', savedContent: null, readOnly: false, persist: true, agentOpened: false }],
    activeIndex: 0,
  })
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
      { key: 'e', title: 'E', savedContent: 7 },
    ],
    activeIndex: 99,
  })
  assert.equal(clean.tabs.length, 2)
  assert.equal(clean.tabs[0].kind, 'query')
  assert.equal(clean.tabs[1].key, 'c')
  assert.equal(clean.activeIndex, 1)
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
