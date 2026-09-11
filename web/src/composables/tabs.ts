import { reactive } from 'vue'

export interface EditorTab {
  key: string
  kind: 'query' | 'ddl'
  title: string
  content: string
  readOnly: boolean
}

const state = reactive({
  tabs: [] as EditorTab[],
  activeKey: '',
  counter: 1,
})

export function useTabs() {
  function activate(key: string) {
    state.activeKey = key
  }

  function newQuery() {
    const key = `query-${state.counter}`
    state.tabs.push({
      key,
      kind: 'query',
      title: `Query ${state.counter}`,
      content: '',
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
      title: suffix ? `${name} ${suffix}` : `${name} (${type})`,
      content: ddl,
      readOnly: !editable,
    })
    state.activeKey = key
  }

  function openFile(name: string, content: string) {
    const key = `file-${state.counter}`
    state.tabs.push({
      key,
      kind: 'query',
      title: name,
      content,
      readOnly: false,
    })
    state.counter++
    state.activeKey = key
  }

  function close(key: string) {
    const index = state.tabs.findIndex((t) => t.key === key)
    if (index === -1) return
    state.tabs.splice(index, 1)
    if (state.activeKey === key) {
      const next = state.tabs[Math.min(index, state.tabs.length - 1)]
      state.activeKey = next?.key ?? ''
    }
  }

  function closeAll() {
    state.tabs = []
    state.activeKey = ''
  }

  function closeOthers(key: string) {
    const keep = state.tabs.find((t) => t.key === key)
    if (!keep) return
    state.tabs = [keep]
    state.activeKey = key
  }

  function closeRight(key: string) {
    const index = state.tabs.findIndex((t) => t.key === key)
    if (index === -1) return
    state.tabs = state.tabs.slice(0, index + 1)
    if (!state.tabs.some((t) => t.key === state.activeKey)) state.activeKey = key
  }

  function updateContent(key: string, content: string) {
    const tab = state.tabs.find((t) => t.key === key)
    if (tab) tab.content = content
  }

  return { state, activate, newQuery, openDdl, openFile, close, closeAll, closeOthers, closeRight, updateContent }
}
