import { reactive } from 'vue'
import { readTextFileHandle, type FileHandle } from '../lib/files'
import { savePinnedFiles, storageReady, type StoredPinnedFile } from '../lib/storage'

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
    .catch(() => undefined)
}

function newPinId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `pin-${Date.now()}-${Math.random().toString(36).slice(2)}`
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
  ) {
    const parentKey = parent ? `--${parent}` : ''
    const key = `ddl-${type}-${schema}-${name}${identity}${parentKey}`
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

  function normalizedContent(content: string): string {
    return content.replace(/\r\n?/g, '\n')
  }

  function isDirty(tab: EditorTab): boolean {
    if (tab.savedContent === null) return tab.kind === 'ddl' ? false : tab.content.length > 0
    return normalizedContent(tab.content) !== normalizedContent(tab.savedContent)
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
    close,
    closeAll,
    closeOthers,
    closeRight,
    updateContent,
    markSaved,
    markPinnedSaved,
    fileHandle,
    isDirty,
    displayTitle,
    pinsReady,
    pinTab,
    unpinFile,
    isPinned,
    openPinned,
  }
}
