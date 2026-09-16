// Browser half of the AI bridge (pure): the app subscribes to the server's SSE
// stream and performs the actions an agent asks for — read the active tab, its
// last result and messages, write SQL into it, open a tab, show agent rows.
// Nothing here runs SQL: the agent's reads go through the server, and the
// editor is for the user to run. Everything is injected, so the reducer is
// unit-testable without Vue or Monaco.

import type { AiActiveResult, AiResultGrid, AiResultMessage } from '../types'

export const AI_TAB_TITLE = 'AI'

/** Fallbacks when the server did not say what the agent may read. */
const AI_RESULT_ROW_CAP = 100
const AI_RESULT_BYTE_CAP = 64 * 1024

export interface BridgeAction {
  id: string
  action: string
  args?: Record<string, unknown>
}

export interface AgentGrid {
  /** Server connection that produced these rows. */
  connectionId: string
  sql: string
  columns: string[]
  columnTypes: string[]
  rows: unknown[][]
  rowCount: number
  truncated: boolean
}

export interface AiTabView {
  key: string
  /** 'query' | 'ddl' — mirrors must be query tabs, so an editable DDL preview
   * literally named "AI" never matches. */
  kind: string
  title: string
  readOnly: boolean
  content: string
  /** Database this tab is bound to, when the tab has connection affinity. */
  connectionId?: string
  /** Explicit mirror-tab ownership. Title matching alone is not ownership. */
  aiMirror?: boolean
}

/** The result state of one tab, as the reducer needs it to answer the agent. */
export interface AiTabResultView {
  running: boolean
  transactionOpen: boolean
  /** Statement number the grid shows; null while Messages is shown. */
  selected: number | null
  messages: AiResultMessage[]
  grids: AiResultGrid[]
}

export interface AiBridgeDeps {
  connectionId(): string | null
  connectionLabel(): string
  tabs(): AiTabView[]
  activeKey(): string
  activateTab(key: string): void
  openSqlTab(title: string, content: string, connectionId: string): void
  openAiMirrorTab(content: string, connectionId: string): void
  updateContent(key: string, content: string): void
  /** Render agent rows in a tab without running a query. Returns false when
   * the tab is busy and must not be overwritten (caller opens another tab). */
  showGrid(tabKey: string, grid: AgentGrid): boolean
  /** Write at the cursor (replacing a selection); false when no editor is mounted. */
  insertAtCursor(sql: string): boolean
  /** The tab's last result state, or null when nothing has been run in it. */
  activeResult(tabKey: string): AiTabResultView | null
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Apply one bridge action; the returned value is the tool call's answer. */
export async function applyBridgeAction(deps: AiBridgeDeps, action: BridgeAction): Promise<unknown> {
  const args = action.args ?? {}
  const activeTab = (): AiTabView | undefined =>
    deps.tabs().find((t) => t.key === deps.activeKey())

  switch (action.action) {
    case 'get-context':
      return {
        connectionId: deps.connectionId(),
        connectionLabel: deps.connectionLabel(),
        activeKey: deps.activeKey() || null,
        tabs: deps.tabs().map((t) => ({ key: t.key, title: t.title, readOnly: t.readOnly })),
      }

    case 'get-active-query': {
      const tab = activeTab()
      if (!tab) throw new Error('No tab is open in pgDEV.')
      return { sql: tab.content, readOnly: tab.readOnly }
    }

    case 'get-active-result': {
      const tab = activeTab()
      if (!tab) throw new Error('No tab is open in pgDEV.')
      const state = deps.activeResult(tab.key)
      // Trim before the payload crosses the bridge: the server's own cap stays
      // authoritative, this only keeps the answer small. `maxBytes` is a safety
      // bound as well, so one huge cell cannot blow the HTTP body limit.
      const maxRows = typeof args.maxRows === 'number' ? args.maxRows : AI_RESULT_ROW_CAP
      const maxBytes = typeof args.maxBytes === 'number' ? args.maxBytes : AI_RESULT_BYTE_CAP
      const results = (state?.grids ?? []).map((grid) => {
        const rows: unknown[][] = []
        let bytes = 0
        for (const row of grid.rows) {
          if (rows.length >= maxRows) break
          const size = JSON.stringify(row)?.length ?? 0
          if (rows.length && bytes + size > maxBytes) break
          bytes += size
          rows.push(row)
        }
        return { ...grid, rows, truncated: grid.truncated || rows.length < grid.rows.length }
      })
      return {
        tab: { key: tab.key, title: tab.title, readOnly: tab.readOnly },
        ran: state !== null,
        running: state?.running ?? false,
        transactionOpen: state?.transactionOpen ?? false,
        selected: state?.selected ?? null,
        messages: state?.messages ?? [],
        results,
      } satisfies AiActiveResult
    }

    case 'set-active-query': {
      const tab = activeTab()
      if (!tab) throw new Error('No tab is open in pgDEV.')
      if (tab.readOnly) throw new Error('The active tab is read-only. Use open_query_tab to stage the change in a new tab.')
      const sql = text(args.sql)
      if (!sql.trim()) throw new Error('"sql" is required.')
      const mode = text(args.mode) || 'replace'
      if (mode === 'insert') {
        if (!deps.insertAtCursor(sql)) {
          throw new Error('No editor is mounted to insert into.')
        }
        return { mode }
      }
      const content =
        mode === 'append'
          ? tab.content.trim()
            ? `${tab.content.replace(/\s+$/, '')}\n\n${sql}`
            : sql
          : sql
      deps.updateContent(tab.key, content)
      return { sql: content }
    }

    case 'open-query-tab': {
      const sql = text(args.sql)
      if (!sql.trim()) throw new Error('"sql" is required.')
      // "AI" is reserved for result-mirror tabs; staged agent SQL gets a
      // neutral title so it never joins the mirror pool.
      const title = text(args.title).trim() || 'Agent SQL'
      deps.openSqlTab(title, sql, deps.connectionId() ?? '')
      return { key: deps.activeKey(), title }
    }

    case 'show-result': {
      const grid = args as unknown as AgentGrid
      if (!grid.connectionId) throw new Error('The agent result has no source connection.')
      // Reuse only an idle, editable, explicitly owned mirror tab bound to
      // the result's source connection. Title alone is not ownership: user
      // query tabs and DDL previews may also be titled "AI".
      const owned = deps.tabs().filter((t) => {
        if (t.aiMirror !== true || t.kind !== 'query' || t.connectionId !== grid.connectionId || t.readOnly)
          return false
        const result = deps.activeResult(t.key)
        return !result?.running && !result?.transactionOpen
      })
      // Deterministic: prefer the active tab when it qualifies, else the
      // most-recently opened owned idle tab.
      const activeKey = deps.activeKey()
      const existing = owned.find((t) => t.key === activeKey) ?? owned.at(-1)
      let key: string
      if (existing) {
        key = existing.key
        deps.activateTab(key)
        deps.updateContent(key, grid.sql)
      } else {
        deps.openAiMirrorTab(grid.sql, grid.connectionId)
        key = deps.activeKey()
      }
      // showGrid itself refuses busy tabs (TOCTOU race): fall back to a fresh
      // mirror tab rather than invalidating in-flight work.
      if (!deps.showGrid(key, grid)) {
        deps.openAiMirrorTab(grid.sql, grid.connectionId)
        key = deps.activeKey()
        if (!deps.showGrid(key, grid)) throw new Error('The AI mirror tab is busy.')
      }
      return { key }
    }

    default:
      throw new Error(`Unknown bridge action "${action.action}".`)
  }
}
