// Browser half of the AI bridge (pure): the app subscribes to the server's SSE
// stream and performs the actions an agent asks for — read the active tab,
// write SQL into it, open a tab, show agent rows. Nothing here runs SQL: the
// agent's reads go through the server, and the editor is for the user to run.
// Everything is injected, so the reducer is unit-testable without Vue or Monaco.

export const AI_TAB_TITLE = 'AI'

export interface BridgeAction {
  id: string
  action: string
  args?: Record<string, unknown>
}

export interface AgentGrid {
  sql: string
  columns: string[]
  columnTypes: string[]
  rows: unknown[][]
  rowCount: number
  truncated: boolean
}

export interface AiTabView {
  key: string
  title: string
  readOnly: boolean
  content: string
}

export interface AiBridgeDeps {
  connectionId(): string | null
  connectionLabel(): string
  tabs(): AiTabView[]
  activeKey(): string
  activateTab(key: string): void
  openSqlTab(title: string, content: string, connectionId: string): void
  updateContent(key: string, content: string): void
  /** Render agent rows in a tab without running a query. */
  showGrid(tabKey: string, grid: AgentGrid): void
  /** Write at the cursor (replacing a selection); false when no editor is mounted. */
  insertAtCursor(sql: string): boolean
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
      const title = text(args.title).trim() || AI_TAB_TITLE
      deps.openSqlTab(title, sql, deps.connectionId() ?? '')
      return { key: deps.activeKey(), title }
    }

    case 'show-result': {
      const grid = args as unknown as AgentGrid
      // Reuse the AI tab so repeated agent queries do not pile up.
      const existing = deps.tabs().find((t) => t.title === AI_TAB_TITLE)
      let key: string
      if (existing) {
        key = existing.key
        deps.activateTab(key)
        deps.updateContent(key, grid.sql)
      } else {
        deps.openSqlTab(AI_TAB_TITLE, grid.sql, deps.connectionId() ?? '')
        key = deps.activeKey()
      }
      deps.showGrid(key, grid)
      return { key }
    }

    default:
      throw new Error(`Unknown bridge action "${action.action}".`)
  }
}
