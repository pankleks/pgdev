import { reactive } from 'vue'
import { api } from '../api'
import { insertAtCursor } from '../lib/formatbridge'
import { AI_TAB_TITLE, applyBridgeAction, type AiBridgeDeps, type BridgeAction } from '../lib/aibridge'
import { useConnection } from './connection'
import { useResults } from './results'
import { useTabs } from './tabs'

export { AI_TAB_TITLE, applyBridgeAction }

export function useAi() {
  const state = reactive({ enabled: false, connected: false })
  let source: EventSource | null = null

  function deps(): AiBridgeDeps {
    const tabs = useTabs()
    const results = useResults()
    const conn = useConnection()
    return {
      connectionId: () => conn.state.id ?? null,
      connectionLabel: () => conn.state.label ?? '',
      tabs: () =>
        tabs.state.tabs.map((t) => ({
          key: t.key,
          title: t.title,
          readOnly: t.readOnly,
          content: t.content,
        })),
      activeKey: () => tabs.state.activeKey,
      activateTab: (key) => tabs.activate(key),
      openSqlTab: (title, content, connectionId) => tabs.openSqlTab(title, content, connectionId),
      updateContent: (key, content) => tabs.updateContent(key, content),
      showGrid: (tabKey, grid) => results.showGrid(tabKey, grid),
      insertAtCursor: (sql) => insertAtCursor(sql),
    }
  }

  async function onAction(data: string): Promise<void> {
    let action: BridgeAction
    try {
      action = JSON.parse(data) as BridgeAction
    } catch {
      return
    }
    let result: unknown = null
    let error: string | null = null
    try {
      result = await applyBridgeAction(deps(), action)
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    }
    await api.aiBridgeResult(action.id, result, error).catch(() => undefined)
  }

  async function start(): Promise<void> {
    if (source) return
    const config = await api.aiConfig().catch(() => null)
    if (!config?.enabled) return
    state.enabled = true
    source = new EventSource('/api/ai/bridge')
    source.onopen = () => {
      state.connected = true
    }
    source.onerror = () => {
      state.connected = false
    }
    source.onmessage = (event) => {
      void onAction(String(event.data))
    }
  }

  return { state, start }
}
