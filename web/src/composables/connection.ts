import { reactive } from 'vue'
import { api } from '../api'
import type { ConnectionConfig } from '../types'
import { saveConnections, storageReady } from '../lib/storage'
import { useSchema } from './schema'
import { useSettings } from './settings'
import { useToast } from './toast'

const state = reactive({
  id: null as string | null,
  label: '',
  dialog: false,
  connecting: false,
  error: '',
})

const savedConnections = reactive<SavedConnection[]>([])
let lastConnection: ConnectionConfig | null = null
let readyPromise: Promise<void> | null = null
let locallyChanged = false
let connectionAttempt = 0

export interface SavedConnection extends ConnectionConfig {
  label: string
}

function labelOf(cfg: ConnectionConfig): string {
  if (cfg.connectionString) {
    return cfg.connectionString.replace(/\/\/([^:]+):[^@]+@/, '//$1:***@')
  }
  return `${cfg.user ?? 'postgres'}@${cfg.host ?? 'localhost'}:${cfg.port ?? 5432}/${cfg.database ?? ''}`
}

function isConnectionConfig(value: unknown): value is ConnectionConfig {
  if (!value || typeof value !== 'object') return false
  const cfg = value as Record<string, unknown>
  return (
    (cfg.connectionString === undefined || typeof cfg.connectionString === 'string') &&
    (cfg.host === undefined || typeof cfg.host === 'string') &&
    (cfg.port === undefined || typeof cfg.port === 'number') &&
    (cfg.database === undefined || typeof cfg.database === 'string') &&
    (cfg.user === undefined || typeof cfg.user === 'string') &&
    (cfg.password === undefined || typeof cfg.password === 'string') &&
    (cfg.ssl === undefined || typeof cfg.ssl === 'boolean')
  )
}

function parseSavedConnections(value: unknown): SavedConnection[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is SavedConnection => {
    if (!entry || typeof entry !== 'object') return false
    const saved = entry as Record<string, unknown>
    return typeof saved.label === 'string' && isConnectionConfig(entry)
  })
}

function ensureReady(): Promise<void> {
  if (!readyPromise) {
    readyPromise = storageReady
      .then(({ connections }) => {
        if (locallyChanged || !connections) return
        savedConnections.splice(0, savedConnections.length, ...parseSavedConnections(connections.saved))
        lastConnection = isConnectionConfig(connections.last) ? { ...connections.last } : null
      })
      .catch(() => undefined)
  }
  return readyPromise
}

function persist() {
  const saved = savedConnections.map((connection) => ({ ...connection }))
  const last = lastConnection ? { ...lastConnection } : null
  void ensureReady().then(() => saveConnections(saved, last)).catch(() => undefined)
}

export function useConnection() {
  function saved(): SavedConnection[] {
    void ensureReady()
    return savedConnections
  }

  function remember(cfg: ConnectionConfig) {
    const label = labelOf(cfg)
    const list = savedConnections.filter((c) => c.label !== label)
    savedConnections.splice(0, savedConnections.length, { ...cfg, label }, ...list.slice(0, 9))
  }

  function rememberLast(cfg: ConnectionConfig) {
    lastConnection = { ...cfg }
  }

  function lastConfig(): ConnectionConfig | null {
    if (lastConnection) return { ...lastConnection }
    return savedConnections.length ? { ...savedConnections[0] } : null
  }

  function forget(label: string) {
    locallyChanged = true
    savedConnections.splice(
      0,
      savedConnections.length,
      ...savedConnections.filter((connection) => connection.label !== label),
    )
    if (lastConnection && labelOf(lastConnection) === label) lastConnection = null
    persist()
  }

  async function connect(cfg: ConnectionConfig, save: boolean, preserveLast = false) {
    if (state.connecting) return
    const attempt = ++connectionAttempt
    state.connecting = true
    state.error = ''
    await ensureReady()
    try {
      const prevId = state.id
      // The statement timeout is a settings-level value (not part of the
      // remembered config) applied when the pool opens: changing it in
      // Settings takes effect on the next connect.
      const body: ConnectionConfig = { ...cfg, statementTimeout: useSettings().state.statementTimeout }
      const { id } = await api.connect(body)
      if (attempt !== connectionAttempt) {
        await api.disconnect(id).catch(() => {})
        return
      }
      if (prevId && prevId !== id) {
        // Switching connections from the badge dialog: close the old pool
        // and drop its per-tab results so stale data isn't shown.
        await api.disconnect(prevId).catch(() => {})
        if (attempt !== connectionAttempt) {
          await api.disconnect(id).catch(() => {})
          return
        }
        try {
          const { useResults } = await import('./results')
          // Re-check after the await: a disconnect+reconnect during the
          // import must not drop the new connection's tab results or
          // overwrite state.id below (which would leak the newer pool).
          // No further awaits follow before the writes, so this closes it.
          if (attempt !== connectionAttempt) {
            await api.disconnect(id).catch(() => {})
            return
          }
          const res = useResults()
          for (const key of Object.keys(res.state.byTab)) res.drop(key)
        } catch {
          // ignore cleanup errors
        }
      }
      useSchema().reset()
      state.id = id
      state.label = labelOf(cfg)
      state.dialog = false
      if (save) {
        locallyChanged = true
        remember(cfg)
        rememberLast(cfg)
        persist()
      } else if (!preserveLast) {
        locallyChanged = true
        lastConnection = null
        persist()
      }
      await useSchema().load(id)
    } catch (e) {
      if (attempt === connectionAttempt) state.error = (e as Error).message
    } finally {
      if (attempt === connectionAttempt) state.connecting = false
    }
  }

  async function autoConnect() {
    await ensureReady()
    const cfg = lastConfig()
    if (!cfg || state.id || state.connecting) return
    await connect(cfg, false, true)
    if (!state.id) {
      state.dialog = true
      useToast().show(`Auto-connect failed: ${state.error}`)
    }
  }

  async function disconnect() {
    const attempt = ++connectionAttempt
    state.connecting = false
    const id = state.id
    if (id) {
      // Best-effort cancel of in-flight queries, then close the pool.
      try {
        const { useResults } = await import('./results')
        const res = useResults()
        const runningKeys = Object.keys(res.state.byTab).filter((key) => {
          const r = res.state.byTab[key]
          return (r.running || r.loadingMore) && !r.cancelling
        })
        await Promise.all(runningKeys.map((key) => res.cancel(key, id).catch(() => undefined)))
        if (attempt !== connectionAttempt) return
        for (const key of Object.keys(res.state.byTab)) res.drop(key)
      } catch {
        // ignore cleanup errors
      }
      await api.disconnect(id).catch(() => {})
    }
    if (attempt !== connectionAttempt) return
    state.id = null
    state.label = ''
    useSchema().reset()
  }

  return { state, connect, disconnect, autoConnect, saved, forget, ready: ensureReady() }
}
