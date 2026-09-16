import { reactive } from 'vue'
import { api, type ApiError } from '../api'
import type { DataResult, FetchMoreResponse, QueryResponse, TransactionState } from '../types'

/** The slice of the API the results state machine drives; tests inject a fake. */
export interface ResultsApi {
  query(connectionId: string, sql: string, tabKey: string, transactionId: string | null): Promise<QueryResponse>
  fetchMore(connectionId: string, tabKey: string): Promise<FetchMoreResponse>
  cancel(connectionId: string, tabKey: string): Promise<{ ok: boolean }>
}

export interface GridResult extends DataResult {
  key: string
  statementNumber: number
  /** Set when a file-stream export drained the remaining cursor: the grid
   * keeps its first page, `rows` is the exported total, and the backend no
   * longer has anything to page. */
  exported?: { rows: number }
}

export interface Message {
  text: string
  level: 'info' | 'error'
  /** PostgreSQL 1-based error offset within the sent SQL, when known. */
  position?: string | null
}

export type QueryErrorInfo = Message

// Statement timeouts surface as 57014 "canceling statement due to statement
// timeout" — previously misreported as a user cancel. The pool runs with a
// 30s statement_timeout (see server connection config).
export function describeQueryError(
  raw: string,
  code: unknown,
  wasCancelling: boolean,
  position?: string | null,
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
    : { text: raw, level: 'error', position: position ?? null }
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
  /** A user-managed transaction is open for this tab (BEGIN without COMMIT yet). */
  transactionOpen: boolean
  transactionId: string | null
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
        transactionOpen: false,
        transactionId: null,
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

  /** Errors without server state (e.g. a network failure) must preserve our expectation. */
  function updateTransaction(
    tabKey: string,
    transaction: Partial<TransactionState>,
    expected?: string | null,
  ) {
    const r = state.byTab[tabKey]
    if (!r || (expected !== undefined && r.transactionId !== expected)) return
    if (transaction.transactionId !== undefined) {
      r.transactionId = transaction.transactionId
      r.transactionOpen = r.transactionId !== null
      return
    }
    // Legacy payloads carry only the boolean flag.
    if (transaction.transactionOpen !== undefined) {
      r.transactionOpen = transaction.transactionOpen
      if (!transaction.transactionOpen) r.transactionId = null
    }
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
      const res = await api.query(connectionId, sql, tabKey, r.transactionId)
      if (!isCurrent(tabKey, r, operation)) return
      updateTransaction(tabKey, res)
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
      const err = e as ApiError
      updateTransaction(tabKey, err)
      const info = describeQueryError(err.message, err.code, r.cancelling, err.position)
      r.messages = [{ text: info.text, level: info.level, position: info.position }]
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
   * Drain all remaining pages, handing every page — starting with the rows
   * already loaded — to `sink`. `grid` is the explicit capture being exported:
   * a selection change while the save picker or the drain is open must not
   * switch the target, so callers pass the grid they captured. Every step
   * re-checks the result identity and operation token.
   *
   * `retain: false` is the file-streaming mode: drained pages are written but
   * NOT appended to the grid, so memory stays flat. Once the cursor is
   * consumed the grid keeps its first page, stops advertising pagination, and
   * records the exported total (`exported`) because Load more can no longer
   * work. Returns true when the drain reached the end of the cursor.
   */
  async function exportAll(
    tabKey: string,
    connectionId: string,
    grid: GridResult,
    sink: (rows: unknown[][]) => void | Promise<void>,
    retain: boolean,
  ): Promise<boolean> {
    const r = state.byTab[tabKey]
    if (!r || r.running || r.loadingMore) return false
    const g = grid
    if (!r.grids.includes(g)) return false
    const operation = r.operation
    r.loadingMore = true
    let exported = 0
    try {
      await sink([...g.rows])
      exported += g.rows.length
      while (isCurrent(tabKey, r, operation) && r.grids.includes(g) && g.truncated && !r.running) {
        const res = await api.fetchMore(connectionId, tabKey)
        if (!isCurrent(tabKey, r, operation) || !r.grids.includes(g)) return false
        await sink(res.rows)
        exported += res.rows.length
        if (retain) {
          g.rows.push(...res.rows)
          g.rowCount = g.rows.length
          g.truncated = res.truncated
        } else if (!res.truncated) {
          // Cursor consumed into the file: the grid keeps its first page and
          // can no longer offer Load more.
          g.truncated = false
          g.exported = { rows: exported }
        }
      }
      if (!isCurrent(tabKey, r, operation) || !r.grids.includes(g)) return false
      const complete = !g.truncated
      r.messages.push({
        text: complete
          ? retain
            ? `Statement ${g.statementNumber}: all rows loaded (${g.rows.length} total).`
            : `Statement ${g.statementNumber}: ${exported} row(s) exported to the file; the grid keeps its first ${g.rows.length}.`
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
  async function loadAll(tabKey: string, connectionId: string, grid: GridResult): Promise<boolean> {
    return exportAll(tabKey, connectionId, grid, () => undefined, true)
  }

  /**
   * Show a result that was produced outside this tab (the AI agent ran it
   * server-side): the grid renders the given rows without going through the
   * query endpoint. Refuses busy tabs — returns false and touches nothing —
   * so in-flight work is never detached from its cancellation UI. The caller
   * opens another tab instead.
   */
  function showGrid(
    tabKey: string,
    data: {
      columns: string[]
      columnTypes: string[]
      rows: unknown[][]
      rowCount: number
      truncated: boolean
    },
  ): boolean {
    const r = ensure(tabKey)
    if (r.running || r.loadingMore || r.cancelling || r.transactionOpen) return false
    r.operation++
    r.running = false
    r.cancelling = false
    r.loadingMore = false
    const key = `grid-${tabKey}-agent`
    r.grids = [
      {
        kind: 'data',
        key,
        statementNumber: 1,
        columns: data.columns,
        columnTypes: data.columnTypes,
        rows: data.rows,
        rowCount: data.rowCount,
        truncated: data.truncated,
      },
    ]
    r.selectedKey = key
    r.showMessages = false
    r.messages = [
      {
        text: `Agent query: ${data.rowCount} row(s)${data.truncated ? ' (agent row limit reached)' : ''}`,
        level: 'info',
      },
    ]
    return true
  }

  return { state, drop, selectGrid, run, cancel, loadMore, loadAll, exportAll, showGrid, updateTransaction }
}

export type Results = ReturnType<typeof createResults>

const shared = createResults(api)

/** The application-wide results store. */
export function useResults(): Results {
  return shared
}
