import type { EditorTab } from '../composables/tabs'

// Session persistence: what gets saved every interval tick and on exit, and
// how it comes back at startup. User-created query tabs are always saved; any
// other tab joins the session once it is dirty, so unsaved edits to a DDL
// preview, generated SQL or file tab survive a restart. Pure and unit-tested;
// storage and timers live elsewhere.

export interface StoredTab {
  /** Original editor key — informational; restore assigns fresh keys. */
  key: string
  title: string
  content: string
  kind: 'query' | 'ddl'
  /** Baseline the content is compared against; null for untitled query tabs. */
  savedContent: string | null
  readOnly: boolean
  /** True for user-created query tabs, which are always saved. */
  persist: boolean
}

export interface TabSession {
  tabs: StoredTab[]
  /** Index of the active tab among the kept tabs (0 when unavailable). */
  activeIndex: number
}

function normalizedContent(content: string): string {
  return content.replace(/\r\n?/g, '\n')
}

/** Unsaved changes, by the same rule the editor strip shows a `*` with. */
export function isTabDirty(tab: EditorTab): boolean {
  // A read-only tab cannot be edited, so it can never be dirty: the AI log and
  // read-only previews stay out of the session.
  if (tab.readOnly) return false
  if (tab.savedContent === null) return tab.kind === 'ddl' ? false : tab.content.length > 0
  return normalizedContent(tab.content) !== normalizedContent(tab.savedContent)
}

/** User query tabs are always saved; every other tab only once it is dirty. */
export function isSessionTab(tab: EditorTab): boolean {
  return tab.persist === true || isTabDirty(tab)
}

/** Snapshot the session tabs, preserving order and the active tab. */
export function serializeSession(tabs: readonly EditorTab[], activeKey: string): TabSession {
  const kept = tabs.filter(isSessionTab)
  const activeIndex = kept.findIndex((tab) => tab.key === activeKey)
  return {
    tabs: kept.map((tab) => ({
      key: tab.key,
      title: tab.title,
      content: tab.content,
      kind: tab.kind,
      savedContent: tab.savedContent,
      readOnly: tab.readOnly,
      persist: tab.persist === true,
    })),
    activeIndex: activeIndex === -1 ? 0 : activeIndex,
  }
}

/**
 * Rebuild stored tabs. `takeKey` supplies fresh editor keys so the caller's
 * counter stays authoritative. A stored baseline is kept for tabs saved
 * because they were dirty (they return dirty and revertible); always-saved
 * query tabs keep the old "restored means unsaved" behavior.
 */
export function restoreSession(session: TabSession, takeKey: () => string): EditorTab[] {
  return session.tabs.map((stored) => ({
    key: takeKey(),
    kind: stored.kind,
    source: 'untitled',
    title: stored.title,
    fileName: null,
    content: stored.content,
    savedContent: stored.persist ? null : stored.savedContent,
    readOnly: stored.readOnly,
    persist: stored.persist ? true : undefined,
  }))
}

/** Defensive parse of whatever storage returned; null when unusable. */
export function sanitizeSession(value: unknown): TabSession | null {
  if (!value || typeof value !== 'object') return null
  const record = value as { tabs?: unknown; activeIndex?: unknown }
  if (!Array.isArray(record.tabs)) return null
  const tabs: StoredTab[] = []
  for (const entry of record.tabs) {
    if (!entry || typeof entry !== 'object') continue
    const tab = entry as Partial<StoredTab>
    if (typeof tab.key !== 'string' || typeof tab.title !== 'string') continue
    if (tab.content !== undefined && typeof tab.content !== 'string') continue
    if (tab.savedContent !== undefined && tab.savedContent !== null && typeof tab.savedContent !== 'string') continue
    tabs.push({
      key: tab.key,
      title: tab.title,
      content: typeof tab.content === 'string' ? tab.content : '',
      kind: tab.kind === 'ddl' ? 'ddl' : 'query',
      savedContent: typeof tab.savedContent === 'string' ? tab.savedContent : null,
      readOnly: tab.readOnly === true,
      // Legacy records predate non-query tabs and were all always-saved query
      // tabs, so a missing flag means true.
      persist: tab.persist !== false,
    })
  }
  const index = record.activeIndex
  const activeIndex =
    typeof index === 'number' && Number.isInteger(index) && index >= 0
      ? Math.min(index, Math.max(0, tabs.length - 1))
      : 0
  return { tabs, activeIndex }
}
