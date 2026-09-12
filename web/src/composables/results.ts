import { reactive } from 'vue'
import { api } from '../api'
import type { DataResult, FetchMoreResponse, QueryResponse } from '../types'

/** The slice of the API the results state machine drives; tests inject a fake. */
export interface ResultsApi {
  query(connectionId: string, sql: string, tabKey: string): Promise<QueryResponse>
  fetchMore(connectionId: string, tabKey: string): Promise<FetchMoreResponse>
  cancel(connectionId: string, tabKey: string): Promise<{ ok: boolean }>
}

export interface GridResult extends DataResult {
  key: string
  statementNumber: number
}

export interface Message {
  text: string
  level: 'info' | 'error'
}

export type QueryErrorInfo = Message

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
  grids: GridResult[]
  /** Which result the grid shows; `grid` derives from it, so a selection can
   * never reference a result outside the current collection. */
  selectedKey: string | null
  readonly grid: GridResult | null
  messages: Message[]
  showMessages: boolean
}

/**
 * Build one results store over an injected API client. The application shares
 * the module-level instance via useResults(); tests construct isolated stores
 * with a fake and import this file directly — no source rewriting needed.
 */
export function createResults(api: ResultsApi) {
  const state = reactive<{ byTab: Record<string, TabResult> }>({ byTab: {} })

  function ensure(key: string): TabResult {
    let r = state.byTab[key]
    if (!r) {
      r = reactive<TabResult>({
        operation: 0,
        running: false,
        cancelling: false,
        loadingMore: false,
        grids: [],
        selectedKey: null,
        get grid(): GridResult | null {
          return this.grids.find((g: GridResult) => g.key === this.selectedKey) ?? null
        },
        messages: [],
        showMessages: false,
      })
      state.byTab[key] = r
    }
    return r
  }

  function isCurrent(key: string, result: TabResult, operation: number): boolean {
    return state.byTab[key] === result && result.operation === operation
  }

  /**
   * Fetch one more page and apply it to the explicitly captured grid. Returns
   * null when the capture went stale (new run, selection change, dropped tab) —
   * the page is then discarded without touching anything.
   */
  async function fetchPageFor(
    tabKey: string,
    connectionId: string,
    r: TabResult,
    operation: number,
    g: GridResult,
  ): Promise<FetchMoreResponse | null> {
    const res = await api.fetchMore(connectionId, tabKey)
    if (!isCurrent(tabKey, r, operation) || !r.grids.includes(g)) return null
    g.rows.push(...res.rows)
    g.rowCount = g.rows.length
    g.truncated = res.truncated
    return res
  }

  function selectGrid(tabKey: string, gridKey: string) {
    const r = state.byTab[tabKey]
    const grid = r?.grids.find((g) => g.key === gridKey)
    if (!r || !grid) return
    r.selectedKey = gridKey
    r.showMessages = false
  }

  function drop(key: string) {
    const r = state.byTab[key]
    if (r) r.operation++
    delete state.byTab[key]
  }

  async function run(tabKey: string, connectionId: string, sql: string) {
    const r = ensure(tabKey)
    if (!sql.trim() || r.running || r.loadingMore) return
    const operation = ++r.operation
    r.running = true
    r.cancelling = false
    r.selectedKey = null
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
      r.selectedKey = grids[0]?.key ?? null
      if (!r.grid) r.showMessages = true
    } catch (e) {
      if (!isCurrent(tabKey, r, operation)) return
      const err = e as Error & { code?: string | null }
      const info = describeQueryError(err.message, err.code, r.cancelling)
      r.messages = [{ text: info.text, level: info.level }]
      r.selectedKey = null
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
      const res = await fetchPageFor(tabKey, connectionId, r, operation, g)
      if (!res) return
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
   * Drain all remaining pages into the grid, handing every page — starting
   * with the rows already loaded — to `sink`. The CSV export streams pages to
   * disk through it instead of building one giant string. Returns true when
   * every row was loaded.
   */
  async function exportAll(
    tabKey: string,
    connectionId: string,
    sink: (rows: unknown[][]) => void,
  ): Promise<boolean> {
    const r = state.byTab[tabKey]
    if (!r?.grid || r.running || r.loadingMore) return (r?.grid && !r.grid.truncated) || false
    const g = r.grid
    const operation = r.operation
    r.loadingMore = true
    try {
      sink([...g.rows])
      while (isCurrent(tabKey, r, operation) && r.grids.includes(g) && g.truncated && !r.running) {
        const res = await fetchPageFor(tabKey, connectionId, r, operation, g)
        if (!res) return false
        sink(res.rows)
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

  /** Drain all remaining pages into the grid (in-place export helper). */
  async function loadAll(tabKey: string, connectionId: string): Promise<boolean> {
    return exportAll(tabKey, connectionId, () => undefined)
  }

  return { state, drop, selectGrid, run, cancel, loadMore, loadAll, exportAll }
}

export type Results = ReturnType<typeof createResults>

const shared = createResults(api)

/** The application-wide results store. */
export function useResults(): Results {
  return shared
}
