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
  cancelling: boolean
  grid: GridResult | null
  messages: Message[]
  showMessages: boolean
}

const state = reactive<{ byTab: Record<string, TabResult> }>({ byTab: {} })

function ensure(key: string): TabResult {
  let r = state.byTab[key]
  if (!r) {
    r = reactive<TabResult>({
      running: false,
      cancelling: false,
      grid: null,
      messages: [],
      showMessages: false,
    })
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
    r.cancelling = false
    r.grid = null
    r.showMessages = false
    r.messages = [{ text: 'Running query…', level: 'info' }]
    try {
      const res = await api.query(connectionId, sql, tabKey)
      const multi = res.results.length > 1
      const messages: Message[] = [
        { text: `${res.results.length} statement(s) in ${res.durationMs} ms`, level: 'info' },
      ]
      const dataItems = res.results.filter((item) => item.kind === 'data')
      let lastData: DataResult | null = null
      for (let idx = 0; idx < res.results.length; idx++) {
        const item = res.results[idx]
        const stmt = multi ? `Statement ${idx + 1}: ` : ''
        if (item.kind === 'command') {
          messages.push({
            text: `${stmt}${item.command}: ${item.rowCount} row(s) affected`,
            level: 'info',
          })
        } else {
          lastData = item
          const truncated = item.truncated ? ` (truncated to ${item.rows.length})` : ''
          messages.push({
            text: `${stmt}${item.rowCount} row(s)${truncated}`,
            level: 'info',
          })
        }
      }
      if (dataItems.length > 1) {
        messages.push({
          text: `Showing last of ${dataItems.length} result sets.`,
          level: 'info',
        })
      }
      r.messages = messages
      r.grid = lastData ? { ...lastData, key: `grid-${tabKey}` } : null
      if (!r.grid) r.showMessages = true
    } catch (e) {
      const wasCancelling = r.cancelling
      const raw = (e as Error).message
      const isCancel =
        wasCancelling || /cancel/i.test(raw) || /57014/.test(raw) || /aborted/i.test(raw)
      r.messages = [
        { text: isCancel ? 'Query canceled.' : raw, level: isCancel ? 'info' : 'error' },
      ]
      r.grid = null
      r.showMessages = true
    } finally {
      r.running = false
      r.cancelling = false
    }
  }

  async function cancel(tabKey: string, connectionId: string) {
    const r = state.byTab[tabKey]
    if (!r?.running || r.cancelling) return
    r.cancelling = true
    await api.cancel(connectionId, tabKey).catch(() => undefined)
  }

  return { state, drop, run, cancel }
}
