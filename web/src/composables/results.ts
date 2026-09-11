import { reactive } from 'vue'
import { api } from '../api'
import type { DataResult } from '../types'

export interface GridResult extends DataResult {
  key: string
}

export interface Message {
  text: string
  level: 'info' | 'error'
}

export interface TabResult {
  running: boolean
  grid: GridResult | null
  messages: Message[]
  showMessages: boolean
}

const state = reactive<{ byTab: Record<string, TabResult> }>({ byTab: {} })

function ensure(key: string): TabResult {
  let r = state.byTab[key]
  if (!r) {
    r = reactive<TabResult>({ running: false, grid: null, messages: [], showMessages: false })
    state.byTab[key] = r
  }
  return r
}

export function useResults() {
  function drop(key: string) {
    delete state.byTab[key]
  }

  async function run(tabKey: string, connectionId: string, sql: string) {
    const r = ensure(tabKey)
    if (!sql.trim() || r.running) return
    r.running = true
    r.grid = null
    r.showMessages = false
    r.messages = [{ text: 'Running query…', level: 'info' }]
    try {
      const res = await api.query(connectionId, sql, tabKey)
      const messages: Message[] = [
        { text: `${res.results.length} statement(s) in ${res.durationMs} ms`, level: 'info' },
      ]
      let lastData: DataResult | null = null
      for (const item of res.results) {
        if (item.kind === 'command') {
          messages.push({
            text: `${item.command}: ${item.rowCount} row(s) affected`,
            level: 'info',
          })
        } else {
          lastData = item
        }
      }
      r.messages = messages
      r.grid = lastData ? { ...lastData, key: `grid-${tabKey}` } : null
      if (!r.grid) r.showMessages = true
    } catch (e) {
      r.messages = [{ text: (e as Error).message, level: 'error' }]
      r.grid = null
      r.showMessages = true
    } finally {
      r.running = false
    }
  }

  async function cancel(tabKey: string, connectionId: string) {
    const r = state.byTab[tabKey]
    if (!r?.running) return
    await api.cancel(connectionId, tabKey).catch(() => undefined)
  }

  return { state, drop, run, cancel }
}
