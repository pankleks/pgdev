import type { EditorTab } from '../composables/tabs'

// Session persistence for user-created query tabs: what gets saved every
// interval tick and on exit, and how it comes back at startup. DDL tabs,
// generated-SQL tabs, file tabs and pinned files are deliberately not part of
// the session. Pure and unit-tested; storage and timers live elsewhere.

export interface StoredTab {
  /** Original editor key — informational; restore assigns fresh keys. */
  key: string
  title: string
  content: string
}

export interface TabSession {
  tabs: StoredTab[]
  /** Index of the active tab among the kept tabs (0 when unavailable). */
  activeIndex: number
}

/** Snapshot the persistable tabs, preserving order and the active tab. */
export function serializeSession(tabs: readonly EditorTab[], activeKey: string): TabSession {
  const kept = tabs.filter((tab) => tab.persist === true)
  const activeIndex = kept.findIndex((tab) => tab.key === activeKey)
  return {
    tabs: kept.map((tab) => ({ key: tab.key, title: tab.title, content: tab.content })),
    activeIndex: activeIndex === -1 ? 0 : activeIndex,
  }
}

/**
 * Rebuild stored tabs as fresh, unsaved query tabs. `takeKey` supplies new
 * editor keys so the caller's counter stays authoritative.
 */
export function restoreSession(session: TabSession, takeKey: () => string): EditorTab[] {
  return session.tabs.map((stored) => ({
    key: takeKey(),
    kind: 'query',
    source: 'untitled',
    title: stored.title,
    fileName: null,
    content: stored.content,
    savedContent: null,
    readOnly: false,
    persist: true,
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
    tabs.push({
      key: tab.key,
      title: tab.title,
      content: typeof tab.content === 'string' ? tab.content : '',
    })
  }
  const index = record.activeIndex
  const activeIndex =
    typeof index === 'number' && Number.isInteger(index) && index >= 0
      ? Math.min(index, Math.max(0, tabs.length - 1))
      : 0
  return { tabs, activeIndex }
}
