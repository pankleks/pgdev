import { reactive } from 'vue'
import { api } from '../api'
import type { DataResult } from '../types'

export interface GridResult extends DataResult {
  key: string
  statementNumber: number
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
  // A user-initiated cancel surfaces as SQLSTATE 57014 ("canceling statement
  // due to user request"); the timeout case is handled above. Matching the
  // message text would misclassify any error that merely contains "cancel".
  // NB: no /aborted/i heuristic — 25P02 "current transaction is aborted"
  // is a server state, not a user cancel; it must surface verbatim.
  const cancelled = wasCancelling || code === '57014'
  return cancelled
    ? { text: 'Query canceled.', level: 'info' }
    : { text: raw, level: 'error' }
}

export interface TabResult {
  operation: number
  running: boolean
  cancelling: boolean
  loadingMore: boolean
  grid: GridResult | null
  grids: GridResult[]
  messages: Message[]
  showMessages: boolean
}

const state = reactive<{ byTab: Record<string, TabResult> }>({ byTab: {} })

function ensure(key: string): TabResult {
  let r = state.byTab[key]
  if (!r) {
    r = reactive<TabResult>({
      operation: 0,
      running: false,
      cancelling: false,
      loadingMore: false,
      grid: null,
      grids: [],
      messages: [],
      showMessages: false,
    })
    state.byTab[key] = r
  }
  return r
}

export function useResults() {
  function selectGrid(tabKey: string, gridKey: string) {
    const r = state.byTab[tabKey]
    const grid = r?.grids.find((g) => g.key === gridKey)
    if (!r || !grid) return
    r.grid = grid
    r.showMessages = false
  }

  function drop(key: string) {
    const r = state.byTab[key]
    if (r) r.operation++
    delete state.byTab[key]
  }

  function isCurrent(key: string, result: TabResult, operation: number): boolean {
    return state.byTab[key] === result && result.operation === operation
  }

  async function run(tabKey: string, connectionId: string, sql: string) {
    const r = ensure(tabKey)
    if (!sql.trim() || r.running || r.loadingMore) return
    const operation = ++r.operation
    r.running = true
    r.cancelling = false
    r.grid = null
    r.grids = []
    r.showMessages = false
    r.messages = [{ text: 'Running query…', level: 'info' }]
    try {
      const res = await api.query(connectionId, sql, tabKey)
      if (!isCurrent(tabKey, r, operation)) return
      const multi = res.results.length > 1
      const messages: Message[] = [
        { text: `${res.results.length} statement(s) in ${res.durationMs} ms`, level: 'info' },
      ]
      const grids: GridResult[] = []
      for (let idx = 0; idx < res.results.length; idx++) {
        const item = res.results[idx]
        const stmt = multi ? `Statement ${idx + 1}: ` : ''
        if (item.kind === 'command') {
          messages.push({
            text: `${stmt}${item.command}: ${item.rowCount} row(s) affected`,
            level: 'info',
          })
        } else {
          grids.push({ ...item, key: `grid-${tabKey}-${idx}`, statementNumber: idx + 1 })
          const truncated = item.truncated
            ? ` (showing first ${item.rows.length} — use Load more)`
            : item.limited
              ? ` (showing first ${item.rows.length} of ${item.totalRowCount} — row limit reached; remaining rows were not retained)`
              : ''
          messages.push({
            text: `${stmt}${item.rowCount} row(s)${truncated}`,
            level: 'info',
          })
        }
      }
      r.messages = messages
      r.grids = grids
      r.grid = r.grids[0] ?? null
      if (!r.grid) r.showMessages = true
    } catch (e) {
      if (!isCurrent(tabKey, r, operation)) return
      const err = e as Error & { code?: string | null }
      const info = describeQueryError(err.message, err.code, r.cancelling)
      r.messages = [{ text: info.text, level: info.level }]
      r.grid = null
      r.grids = []
      r.showMessages = true
    } finally {
      if (isCurrent(tabKey, r, operation)) {
        r.running = false
        r.cancelling = false
      }
    }
  }

  async function cancel(tabKey: string, connectionId: string) {
    const r = state.byTab[tabKey]
    if ((!r?.running && !r?.loadingMore) || r.cancelling) return
    r.cancelling = true
    await api.cancel(connectionId, tabKey).catch(() => undefined)
  }

  async function loadMore(tabKey: string, connectionId: string) {
    const r = state.byTab[tabKey]
    if (!r?.grid?.truncated || r.running || r.loadingMore) return
    const g = r.grid
    const operation = r.operation
    r.loadingMore = true
    try {
      const res = await api.fetchMore(connectionId, tabKey)
      if (!isCurrent(tabKey, r, operation) || !r.grids.includes(g)) return
      g.rows.push(...res.rows)
      g.rowCount = g.rows.length
      g.truncated = res.truncated
      r.messages.push({
        text: res.truncated
          ? `Statement ${g.statementNumber}: loaded ${res.rows.length} more row(s) (${g.rows.length} total — more available).`
          : `Statement ${g.statementNumber}: loaded ${res.rows.length} more row(s) (${g.rows.length} total, all rows).`,
        level: 'info',
      })
    } catch (e) {
      if (isCurrent(tabKey, r, operation)) r.messages.push({ text: (e as Error).message, level: 'error' })
    } finally {
      if (isCurrent(tabKey, r, operation)) {
        r.loadingMore = false
        r.cancelling = false
      }
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
    const operation = r.operation
    r.loadingMore = true
    try {
      while (isCurrent(tabKey, r, operation) && r.grids.includes(g) && g.truncated && !r.running) {
        const res = await api.fetchMore(connectionId, tabKey)
        if (!isCurrent(tabKey, r, operation) || !r.grids.includes(g)) return false
        g.rows.push(...res.rows)
        g.rowCount = g.rows.length
        g.truncated = res.truncated
      }
      if (!isCurrent(tabKey, r, operation)) return false
      const complete = r.grids.includes(g) && !g.truncated
      r.messages.push({
        text: complete
          ? `Statement ${g.statementNumber}: all rows loaded (${g.rows.length} total).`
          : 'Stopped early — grid changed during load.',
        level: complete ? 'info' : 'error',
      })
      return complete
    } catch (e) {
      if (isCurrent(tabKey, r, operation)) r.messages.push({ text: (e as Error).message, level: 'error' })
      return false
    } finally {
      if (isCurrent(tabKey, r, operation)) {
        r.loadingMore = false
        r.cancelling = false
      }
    }
  }

  return { state, drop, selectGrid, run, cancel, loadMore, loadAll }
}
