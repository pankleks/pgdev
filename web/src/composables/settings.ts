import { reactive } from 'vue'
import { saveSettings, storageReady } from '../lib/storage'
import { AI_LIMIT_RANGES, DEFAULT_AI_LIMITS } from '../types'

/** Object-browser expansion state for one connection. Keys are catalog keys
 * (`t-<oid>`, `t-<oid>-cols`, …) and group keys; OIDs are only unique per
 * database, so state is stored per connection label, never globally. */
export interface BrowserUiState {
  sections: { tables: boolean; views: boolean; functions: boolean; types: boolean }
  expanded: string[]
  groups: { tables: string[]; views: string[]; functions: string[]; types: string[] }
}

interface SettingsState {
  groupObjects: boolean
  panelSizes: { sideW: number; resultsH: number }
  browserExpanded: Record<string, BrowserUiState>
  /** Statement timeout in seconds; applied to pools when a connection opens. */
  statementTimeout: number
  /** Monaco editor font size in px. */
  editorFontSize: number
  /** How much of a result set the AI agent may read, per result set. */
  aiLimitRows: number
  /** The same limit as a JSON byte budget, in KB. */
  aiLimitKb: number
}

const STATEMENT_TIMEOUT = { min: 1, max: 600, fallback: 30 } as const
const EDITOR_FONT = { min: 8, max: 32, fallback: 14 } as const

const AI_LIMIT_ROWS = {
  min: AI_LIMIT_RANGES.maxRows.min,
  max: AI_LIMIT_RANGES.maxRows.max,
  fallback: DEFAULT_AI_LIMITS.maxRows,
} as const
const AI_LIMIT_KB = {
  min: AI_LIMIT_RANGES.maxBytes.min / 1024,
  max: AI_LIMIT_RANGES.maxBytes.max / 1024,
  fallback: DEFAULT_AI_LIMITS.maxBytes / 1024,
} as const

const SIZE_LIMITS = {
  sideW: { min: 180, max: 640, fallback: 336 },
  resultsH: { min: 80, max: 4000, fallback: 240 },
} as const

const MAX_TRACKED_CONNECTIONS = 24
const MAX_KEYS_PER_LIST = 2000

function clampSize(value: unknown, limits: { min: number; max: number; fallback: number }): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return limits.fallback
  return Math.min(limits.max, Math.max(limits.min, Math.round(value)))
}

function clampStatementTimeout(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return STATEMENT_TIMEOUT.fallback
  return Math.min(STATEMENT_TIMEOUT.max, Math.max(STATEMENT_TIMEOUT.min, Math.round(value)))
}

function clampEditorFontSize(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return EDITOR_FONT.fallback
  return Math.min(EDITOR_FONT.max, Math.max(EDITOR_FONT.min, Math.round(value)))
}

function clampAiLimit(value: unknown, limits: { min: number; max: number; fallback: number }): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return limits.fallback
  return Math.min(limits.max, Math.max(limits.min, Math.round(value)))
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string').slice(0, MAX_KEYS_PER_LIST)
}

/** Defensive parse of a stored state — anything unexpected falls back to defaults. */
function sanitizeBrowserState(value: unknown): BrowserUiState | null {
  if (!value || typeof value !== 'object') return null
  const s = value as Partial<BrowserUiState>
  const bool = (v: unknown): boolean => v === true
  return {
    sections: {
      tables: bool(s.sections?.tables),
      views: bool(s.sections?.views),
      functions: bool(s.sections?.functions),
      types: bool(s.sections?.types),
    },
    expanded: stringList(s.expanded),
    groups: {
      tables: stringList(s.groups?.tables),
      views: stringList(s.groups?.views),
      functions: stringList(s.groups?.functions),
      types: stringList(s.groups?.types),
    },
  }
}

const state = reactive<SettingsState>({
  groupObjects: true,
  panelSizes: { sideW: SIZE_LIMITS.sideW.fallback, resultsH: SIZE_LIMITS.resultsH.fallback },
  browserExpanded: {},
  statementTimeout: STATEMENT_TIMEOUT.fallback,
  editorFontSize: EDITOR_FONT.fallback,
  aiLimitRows: AI_LIMIT_ROWS.fallback,
  aiLimitKb: AI_LIMIT_KB.fallback,
})

let readyPromise: Promise<void> | null = null
let locallyChanged = false

function ensureReady(): Promise<void> {
  if (!readyPromise) {
    readyPromise = storageReady
      .then(({ settings }) => {
        if (locallyChanged || !settings || typeof settings !== 'object') return
        const saved = settings as Partial<SettingsState>
        if (typeof saved.groupObjects === 'boolean') state.groupObjects = saved.groupObjects
        if (typeof saved.statementTimeout !== 'undefined') {
          state.statementTimeout = clampStatementTimeout(saved.statementTimeout)
        }
        if (typeof saved.editorFontSize !== 'undefined') {
          state.editorFontSize = clampEditorFontSize(saved.editorFontSize)
        }
        if (typeof saved.aiLimitRows !== 'undefined') {
          state.aiLimitRows = clampAiLimit(saved.aiLimitRows, AI_LIMIT_ROWS)
        }
        if (typeof saved.aiLimitKb !== 'undefined') {
          state.aiLimitKb = clampAiLimit(saved.aiLimitKb, AI_LIMIT_KB)
        }
        if (saved.panelSizes && typeof saved.panelSizes === 'object') {
          state.panelSizes.sideW = clampSize(saved.panelSizes.sideW, SIZE_LIMITS.sideW)
          state.panelSizes.resultsH = clampSize(saved.panelSizes.resultsH, SIZE_LIMITS.resultsH)
        }
        if (saved.browserExpanded && typeof saved.browserExpanded === 'object') {
          for (const [label, ui] of Object.entries(saved.browserExpanded)) {
            const clean = sanitizeBrowserState(ui)
            if (clean) state.browserExpanded[label] = clean
          }
        }
      })
      .catch(() => undefined)
  }
  return readyPromise
}

function persist() {
  // Clone through JSON so the reactive proxies are not handed to structured
  // cloning in the IndexedDB write.
  const value = JSON.parse(JSON.stringify({
    groupObjects: state.groupObjects,
    panelSizes: state.panelSizes,
    browserExpanded: state.browserExpanded,
    statementTimeout: state.statementTimeout,
    editorFontSize: state.editorFontSize,
    aiLimitRows: state.aiLimitRows,
    aiLimitKb: state.aiLimitKb,
  })) as SettingsState
  void ensureReady().then(() => saveSettings(value)).catch(() => undefined)
}

export function useSettings() {
  const ready = ensureReady()

  function setGroupObjects(enabled: boolean) {
    locallyChanged = true
    state.groupObjects = enabled
    persist()
  }

  function setStatementTimeout(seconds: number) {
    state.statementTimeout = clampStatementTimeout(seconds)
    persist()
  }

  function setEditorFontSize(px: number) {
    state.editorFontSize = clampEditorFontSize(px)
    persist()
  }

  function setAiLimitRows(rows: number) {
    state.aiLimitRows = clampAiLimit(rows, AI_LIMIT_ROWS)
    persist()
  }

  function setAiLimitKb(kb: number) {
    state.aiLimitKb = clampAiLimit(kb, AI_LIMIT_KB)
    persist()
  }

  /** Restore every preference to its default (per-connection expansion is
   * recorded state, not a preference, so it is left alone). */
  function resetToDefaults() {
    locallyChanged = true
    state.groupObjects = true
    state.statementTimeout = STATEMENT_TIMEOUT.fallback
    state.editorFontSize = EDITOR_FONT.fallback
    state.aiLimitRows = AI_LIMIT_ROWS.fallback
    state.aiLimitKb = AI_LIMIT_KB.fallback
    state.panelSizes.sideW = SIZE_LIMITS.sideW.fallback
    state.panelSizes.resultsH = SIZE_LIMITS.resultsH.fallback
    persist()
  }

  function setPanelSizes(sideW: number, resultsH: number) {
    state.panelSizes.sideW = clampSize(sideW, SIZE_LIMITS.sideW)
    state.panelSizes.resultsH = clampSize(resultsH, SIZE_LIMITS.resultsH)
    persist()
  }

  function setBrowserState(label: string, ui: BrowserUiState) {
    if (!label) return
    const clean = sanitizeBrowserState(ui)
    if (!clean) return
    const keys = Object.keys(state.browserExpanded)
    if (!(label in state.browserExpanded) && keys.length >= MAX_TRACKED_CONNECTIONS) {
      delete state.browserExpanded[keys[0]]
    }
    state.browserExpanded[label] = clean
    persist()
  }

  function browserStateFor(label: string): BrowserUiState | null {
    return (label && state.browserExpanded[label]) || null
  }

  return { state, setGroupObjects, setStatementTimeout, setEditorFontSize, setAiLimitRows, setAiLimitKb, setPanelSizes, setBrowserState, browserStateFor, resetToDefaults, ready }
}
