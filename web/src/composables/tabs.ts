import { reactive } from 'vue'
import { readTextFileHandle, type FileHandle } from '../lib/files'
import { loadTabSession, savePinnedFiles, saveTabSession, storageReady, type StoredPinnedFile } from '../lib/storage'
import { isSessionTab, isTabDirty, restoreSession, serializeSession } from '../lib/tabsession'
import { useToast } from './toast'

export interface EditorTab {
  key: string
  kind: 'query' | 'ddl'
  source: 'untitled' | 'file'
  title: string
  fileName: string | null
  content: string
  savedContent: string | null
  readOnly: boolean
  pinnedId?: string
  /** Connection a DDL tab was generated from (absent for query/file tabs). */
  connectionId?: string
  /** The single AI log tab: read-only, connection-free, append-only. Title
   * matching is not ownership — user tabs and DDL previews may also be titled
   * "AI". */
  aiMirror?: boolean
  /** True only for tabs the agent opened (staged SQL, mirror tabs). The agent
   * may list, activate and close these — and only these. */
  agentOpened?: boolean
  /** True only for user-created query tabs, which the tab session always
   * saves. Other tabs still join the session once they are dirty. */
  persist?: boolean
}

export interface PinnedFile {
  id: string
  order: number
  fileName: string
  content: string
}

const state = reactive({
  tabs: [] as EditorTab[],
  activeKey: '',
  counter: 1,
  pinnedFiles: [] as PinnedFile[],
})
const fileHandles = new Map<string, FileHandle>()
const pinnedHandles = new Map<string, FileHandle>()
let pinWrite = Promise.resolve()

const pinsReady = storageReady
  .then(({ pinnedFiles }) => {
    pinnedHandles.clear()
    state.pinnedFiles.splice(0, state.pinnedFiles.length)
    for (const { handle, ...pin } of [...pinnedFiles].sort((a, b) => a.order - b.order)) {
      state.pinnedFiles.push(pin)
      if (handle) pinnedHandles.set(pin.id, handle)
    }
  })
  .catch(() => undefined)

function persistPins() {
  const snapshot: StoredPinnedFile[] = state.pinnedFiles.map((pin) => ({
    ...pin,
    handle: pinnedHandles.get(pin.id),
  }))
  pinWrite = pinWrite
    .then(() => storageReady)
    .then(() => savePinnedFiles(snapshot).then(() => undefined))
    .catch((e: unknown) => {
      // Every in-storage fallback failed; the pins exist only in memory and
      // a refresh loses them. Say so instead of failing silently.
      const message = e instanceof Error ? e.message : String(e)
      useToast().show(`Pinned files are not being saved: ${message}`)
    })
}

function newPinId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `pin-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

// --- tab session -----------------------------------------------------------
// User-created query tabs, plus any other tab with unsaved changes, are
// snapshotted every SESSION_SAVE_INTERVAL_MS and on exit, and restored once at
// startup. A cheap signature comparison skips the write while nothing changed;
// connection state is deliberately not part of any of this.

export const SESSION_SAVE_INTERVAL_MS = 10_000

let sessionLoaded = false
let lastSessionSignature = ''

function sessionSignature(): string {
  return JSON.stringify({
    active: state.activeKey,
    tabs: state.tabs
      .filter(isSessionTab)
      .map((tab) => [tab.key, tab.title, tab.content, tab.kind, tab.savedContent]),
  })
}

async function saveSessionIfChanged(): Promise<void> {
  if (!sessionLoaded) return
  const signature = sessionSignature()
  if (signature === lastSessionSignature) return
  lastSessionSignature = signature
  try {
    await saveTabSession(serializeSession(state.tabs, state.activeKey))
  } catch {
    // Let the next tick retry rather than silently dropping the change.
    lastSessionSignature = ''
  }
}

/**
 * Loads and restores the saved session exactly once. `sessionsReady` resolves
 * after the restore so App.vue can create the default tab only when nothing
 * came back.
 */
export const sessionsReady = (async () => {
  try {
    const session = await loadTabSession()
    if (session && session.tabs.length) {
      const restored = restoreSession(session, () => `query-${state.counter++}`)
      state.tabs.splice(0, state.tabs.length, ...restored)
      state.activeKey = restored[session.activeIndex]?.key ?? restored[0]?.key ?? ''
    }
  } catch {
    // Storage is unavailable; start from an empty strip.
  }
  sessionLoaded = true
  lastSessionSignature = sessionSignature()
})()

// Timers and unload handlers exist only in the browser, so unit tests that
// import this module are not kept alive by a pending interval.
if (typeof window !== 'undefined') {
  window.setInterval(() => {
    void saveSessionIfChanged()
  }, SESSION_SAVE_INTERVAL_MS)
  window.addEventListener('pagehide', () => {
    void saveSessionIfChanged()
  })
}

function updatePinnedFile(id: string, fileName: string, content: string, handle?: FileHandle) {
  const pin = state.pinnedFiles.find((entry) => entry.id === id)
  if (!pin) return
  pin.fileName = fileName
  pin.content = content
  if (handle) pinnedHandles.set(id, handle)
  else pinnedHandles.delete(id)
  persistPins()
}

export function useTabs() {
  function activate(key: string) {
    state.activeKey = key
  }

  function newQuery() {
    const key = `query-${state.counter}`
    state.tabs.push({
      key,
      kind: 'query',
      source: 'untitled',
      title: `Query ${state.counter}`,
      fileName: null,
      content: '',
      savedContent: null,
      readOnly: false,
      persist: true,
    })
    state.counter++
    state.activeKey = key
  }

  function openDdl(
    type: string,
    schema: string,
    name: string,
    ddl: string,
    identity = '',
    editable = false,
    parent = '',
    connectionId = '',
  ) {
    const parentKey = parent ? `--${parent}` : ''
    // Scoping the key to the connection keeps DDL from two databases apart.
    // Without it a stale tab is silently reused (and run) against whichever
    // database is connected now, and oids are only unique per database.
    const connKey = connectionId ? `--${connectionId.slice(0, 8)}` : ''
    const baseKey = `ddl-${type}-${schema}-${name}${identity}${parentKey}`
    const key = `${baseKey}${connKey}`
    const existing = state.tabs.find((t) => t.key === key)
    if (existing) {
      // Re-opening refreshes the tab from the database, which would discard
      // unsaved edits. Ask first (mirrors canClose in EditorTabs): declining
      // keeps the local edits and just focuses the tab.
      if (
        existing.content !== ddl &&
        isDirty(existing) &&
        !window.confirm(`Discard unsaved changes in "${existing.title}" and reload from the database?`)
      ) {
        state.activeKey = key
        return
      }
      if (existing.content !== ddl) existing.content = ddl
      existing.savedContent = ddl
      existing.readOnly = !editable
      existing.connectionId = connectionId || existing.connectionId
      state.activeKey = key
      return
    }
    state.tabs.push({
      key,
      kind: 'ddl',
      source: 'untitled',
      title: name,
      fileName: null,
      content: ddl,
      savedContent: ddl,
      readOnly: !editable,
      connectionId: connectionId || undefined,
    })
    state.activeKey = key
  }

  function openFile(name: string, content: string, handle?: FileHandle, pinnedId?: string) {
    const key = `file-${state.counter}`
    state.tabs.push({
      key,
      kind: 'query',
      source: 'file',
      title: name,
      fileName: name,
      content,
      savedContent: content,
      readOnly: false,
      pinnedId,
    })
    if (handle) fileHandles.set(key, handle)
    state.counter++
    state.activeKey = key
  }

  /**
   * Generated SQL (e.g. the table editor's change-only script) in a fresh,
   * clean query tab. `savedContent` is preset so the tab is not flagged dirty,
   * and an optional connection keeps the run-here guard from App.vue active:
   * a script generated against one database must not run against another.
   */
  function openSqlTab(title: string, content: string, connectionId = '', agent = false) {
    const key = `sql-${state.counter}`
    state.tabs.push({
      key,
      kind: 'query',
      source: 'untitled',
      title,
      fileName: null,
      content,
      savedContent: content,
      readOnly: false,
      connectionId: connectionId || undefined,
      agentOpened: agent || undefined,
    })
    state.counter++
    state.activeKey = key
  }

  /**
   * The single AI log tab: a read-only, append-only record of every agent
   * query's SQL, reused (never duplicated) and deliberately not bound to a
   * connection. Created on first use; the user may close it and the next
   * agent result recreates it. Owned by the explicit `aiMirror` flag, never by
   * title.
   */
  function showAiLog(entry: string): string {
    const existing = state.tabs.find((t) => t.aiMirror === true)
    if (existing) {
      existing.content = existing.content.trim()
        ? `${existing.content.replace(/\s+$/, '')}\n\n${entry}`
        : entry
      state.activeKey = existing.key
      return existing.key
    }
    const key = 'ai-log'
    state.tabs.push({
      key,
      kind: 'query',
      source: 'untitled',
      title: 'AI',
      fileName: null,
      content: entry,
      savedContent: null,
      readOnly: true,
      aiMirror: true,
    })
    state.activeKey = key
    return key
  }

  function close(key: string) {
    const index = state.tabs.findIndex((t) => t.key === key)
    if (index === -1) return
    fileHandles.delete(key)
    state.tabs.splice(index, 1)
    if (state.activeKey === key) {
      const next = state.tabs[Math.min(index, state.tabs.length - 1)]
      state.activeKey = next?.key ?? ''
    }
  }

  function closeAll() {
    fileHandles.clear()
    state.tabs = []
    state.activeKey = ''
  }

  function closeOthers(key: string) {
    const keep = state.tabs.find((t) => t.key === key)
    if (!keep) return
    for (const tab of state.tabs) {
      if (tab.key !== key) fileHandles.delete(tab.key)
    }
    state.tabs = [keep]
    state.activeKey = key
  }

  function closeRight(key: string) {
    const index = state.tabs.findIndex((t) => t.key === key)
    if (index === -1) return
    for (const tab of state.tabs.slice(index + 1)) fileHandles.delete(tab.key)
    state.tabs = state.tabs.slice(0, index + 1)
    if (!state.tabs.some((t) => t.key === state.activeKey)) state.activeKey = key
  }

  /**
   * Move a tab to an insertion position in the current order (0 = front,
   * `state.tabs.length` = end). Dropping in place is a no-op; the active tab is
   * independent of order, so it does not change.
   */
  function moveTabToIndex(key: string, index: number) {
    const from = state.tabs.findIndex((t) => t.key === key)
    if (from === -1) return
    const to = Math.max(0, Math.min(state.tabs.length, index))
    if (to === from || to === from + 1) return
    const tab = state.tabs[from]
    state.tabs.splice(from, 1)
    state.tabs.splice(from < to ? to - 1 : to, 0, tab)
  }

  function updateContent(key: string, content: string) {
    const tab = state.tabs.find((t) => t.key === key)
    if (tab) tab.content = content
  }

  function markSaved(key: string, fileName: string, handle?: FileHandle, savedContent?: string) {
    const tab = state.tabs.find((t) => t.key === key)
    if (!tab) return
    tab.source = 'file'
    tab.fileName = fileName
    tab.title = fileName
    tab.savedContent = savedContent ?? tab.content
    if (handle) fileHandles.set(key, handle)
    else fileHandles.delete(key)

    if (tab.pinnedId) updatePinnedFile(tab.pinnedId, fileName, tab.savedContent, handle)
  }

  function markPinnedSaved(id: string, fileName: string, content: string, handle?: FileHandle) {
    updatePinnedFile(id, fileName, content, handle)
  }

  function fileHandle(key: string): FileHandle | undefined {
    return fileHandles.get(key)
  }

  function isDirty(tab: EditorTab): boolean {
    return isTabDirty(tab)
  }

  function displayTitle(tab: EditorTab): string {
    return isDirty(tab) ? `${tab.title} *` : tab.title
  }

  async function pinTab(key: string) {
    await pinsReady
    const tab = state.tabs.find((entry) => entry.key === key)
    if (!tab || tab.source !== 'file') return
    if (tab.pinnedId && state.pinnedFiles.some((pin) => pin.id === tab.pinnedId)) return

    const id = newPinId()
    const pin: PinnedFile = {
      id,
      order: state.pinnedFiles.reduce((max, entry) => Math.max(max, entry.order), -1) + 1,
      fileName: tab.fileName ?? tab.title,
      content: tab.savedContent ?? tab.content,
    }
    state.pinnedFiles.push(pin)
    tab.pinnedId = id
    const handle = fileHandles.get(key)
    if (handle) pinnedHandles.set(id, handle)
    persistPins()
  }

  async function unpinFile(id: string) {
    await pinsReady
    const index = state.pinnedFiles.findIndex((pin) => pin.id === id)
    if (index === -1) return
    state.pinnedFiles.splice(index, 1)
    pinnedHandles.delete(id)
    for (const tab of state.tabs) {
      if (tab.pinnedId === id) tab.pinnedId = undefined
    }
    persistPins()
  }

  function isPinned(key: string): boolean {
    const tab = state.tabs.find((entry) => entry.key === key)
    return !!tab?.pinnedId && state.pinnedFiles.some((pin) => pin.id === tab.pinnedId)
  }

  async function openPinned(id: string): Promise<'handle' | 'snapshot' | 'fallback' | null> {
    await pinsReady
    const pin = state.pinnedFiles.find((entry) => entry.id === id)
    if (!pin) return null

    const handle = pinnedHandles.get(id)
    if (!handle) {
      openFile(pin.fileName, pin.content, undefined, id)
      return 'snapshot'
    }

    try {
      const opened = await readTextFileHandle(handle)
      if (!state.pinnedFiles.some((entry) => entry.id === id)) return null
      pin.fileName = opened.fileName
      pin.content = opened.content
      persistPins()
      openFile(opened.fileName, opened.content, handle, id)
      return 'handle'
    } catch {
      if (!state.pinnedFiles.some((entry) => entry.id === id)) return null
      openFile(pin.fileName, pin.content, handle, id)
      return 'fallback'
    }
  }

  return {
    state,
    activate,
    newQuery,
    openDdl,
    openFile,
    openSqlTab,
    showAiLog,
    close,
    closeAll,
    closeOthers,
    closeRight,
    moveTabToIndex,
    updateContent,
    markSaved,
    markPinnedSaved,
    fileHandle,
    isDirty,
    displayTitle,
    pinsReady,
    sessionsReady,
    pinTab,
    unpinFile,
    isPinned,
    openPinned,
  }
}
