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

  function openDdl(type: string, schema: string, name: string, ddl: string, suffix = '') {
    const key = `ddl-${type}-${schema}-${name}${suffix}`
    const existing = state.tabs.find((t) => t.key === key)
    if (existing) {
      state.activeKey = key
      return
    }
    state.tabs.push({
      key,
      kind: 'ddl',
      title: suffix ? `${name} ${suffix}` : `${name} (${type})`,
      content: ddl,
      readOnly: true,
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

  function updateContent(key: string, content: string) {
    const tab = state.tabs.find((t) => t.key === key)
    if (tab) tab.content = content
  }

  return { state, activate, newQuery, openDdl, openFile, close, updateContent }
}
