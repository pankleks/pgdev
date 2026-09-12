import { reactive } from 'vue'
import type { FileHandle } from '../lib/files'

export interface EditorTab {
  key: string
  kind: 'query' | 'ddl'
  source: 'untitled' | 'file'
  title: string
  fileName: string | null
  content: string
  savedContent: string | null
  readOnly: boolean
}

const state = reactive({
  tabs: [] as EditorTab[],
  activeKey: '',
  counter: 1,
})
const fileHandles = new Map<string, FileHandle>()

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
    suffix = '',
    editable = false,
    parent = '',
  ) {
    const parentKey = parent ? `--${parent}` : ''
    const key = `ddl-${type}-${schema}-${name}${suffix}${parentKey}`
    const existing = state.tabs.find((t) => t.key === key)
    if (existing) {
      if (existing.content !== ddl) existing.content = ddl
      existing.readOnly = !editable
      state.activeKey = key
      return
    }
    state.tabs.push({
      key,
      kind: 'ddl',
      source: 'untitled',
      title: suffix ? `${name} ${suffix}` : `${name} (${type})`,
      fileName: null,
      content: ddl,
      savedContent: null,
      readOnly: !editable,
    })
    state.activeKey = key
  }

  function openFile(name: string, content: string, handle?: FileHandle) {
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
  }

  function fileHandle(key: string): FileHandle | undefined {
    return fileHandles.get(key)
  }

  function isDirty(tab: EditorTab): boolean {
    return tab.savedContent === null ? tab.content.length > 0 : tab.content !== tab.savedContent
  }

  function displayTitle(tab: EditorTab): string {
    return isDirty(tab) ? `${tab.title} *` : tab.title
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
    fileHandle,
    isDirty,
    displayTitle,
  }
}
