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

export interface QueryErrorInfo {
  text: string
  level: 'info' | 'error'
}

// Statement timeouts surface as 57014 "canceling statement due to statement
// timeout" — previously misreported as a user cancel. The pool runs with a
// 30s statement_timeout (see server connection config).
export function describeQueryError(
  raw: string,
  code: unknown,
  wasCancelling: boolean,
): QueryErrorInfo {
  if (/statement timeout/i.test(raw)) {
    return { text: 'Query timed out (30s statement limit).', level: 'error' }
  }
  // NB: no /aborted/i heuristic — 25P02 "current transaction is aborted"
  // is a server state, not a user cancel; it must surface verbatim.
  const cancelled =
    wasCancelling || /cancel/i.test(raw) || /57014/.test(raw) || code === '57014'
  return cancelled
    ? { text: 'Query canceled.', level: 'info' }
    : { text: raw, level: 'error' }
}

export interface TabResult {
  running: boolean
  cancelling: boolean
  loadingMore: boolean
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
      loadingMore: false,
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
          const truncated = item.truncated
            ? ` (showing first ${item.rows.length} — use Load more)`
            : ''
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
      const err = e as Error & { code?: string | null }
      const info = describeQueryError(err.message, err.code, r.cancelling)
      r.messages = [{ text: info.text, level: info.level }]
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

  async function loadMore(tabKey: string, connectionId: string) {
    const r = state.byTab[tabKey]
    if (!r?.grid?.truncated || r.running || r.loadingMore) return
    r.loadingMore = true
    try {
      const res = await api.fetchMore(connectionId, tabKey)
      if (r.grid === null) return
      r.grid.rows.push(...res.rows)
      r.grid.rowCount = r.grid.rows.length
      r.grid.truncated = res.truncated
      r.messages.push({
        text: res.truncated
          ? `Loaded ${res.rows.length} more row(s) (${r.grid.rows.length} total — more available).`
          : `Loaded ${res.rows.length} more row(s) (${r.grid.rows.length} total, all rows).`,
        level: 'info',
      })
    } catch (e) {
      r.messages.push({ text: (e as Error).message, level: 'error' })
    } finally {
      r.loadingMore = false
    }
  }

  /**
   * Drain all remaining pages into the grid (for CSV export).
   * Aborts safely if a new query replaces the grid mid-drain.
   * Returns true when every row was loaded.
   */
  async function loadAll(tabKey: string, connectionId: string): Promise<boolean> {
    const r = state.byTab[tabKey]
    if (!r?.grid || r.running || r.loadingMore) return (r?.grid && !r.grid.truncated) || false
    const g = r.grid
    r.loadingMore = true
    try {
      while (r.grid === g && g.truncated && !r.running) {
        const res = await api.fetchMore(connectionId, tabKey)
        if (r.grid !== g) return false
        g.rows.push(...res.rows)
        g.rowCount = g.rows.length
        g.truncated = res.truncated
      }
      const complete = r.grid === g && !g.truncated
      r.messages.push({
        text: complete
          ? `All rows loaded (${g.rows.length} total).`
          : 'Stopped early — grid changed during load.',
        level: complete ? 'info' : 'error',
      })
      return complete
    } catch (e) {
      r.messages.push({ text: (e as Error).message, level: 'error' })
      return false
    } finally {
      r.loadingMore = false
    }
  }

  return { state, drop, run, cancel, loadMore, loadAll }
}
