import { reactive } from 'vue'
import { api } from '../api'
import type { ConnectionConfig } from '../types'
import { saveConnections, storageReady } from '../lib/storage'
import { assignSeqs, maxSeq, parseConnectNumber } from '../lib/connectionref'
import { useSchema } from './schema'
import { useSettings } from './settings'
import { useToast } from './toast'

const state = reactive({
  id: null as string | null,
  label: '',
  pgVersion: '',
  dialog: false,
  connecting: false,
  error: '',
})

const savedConnections = reactive<SavedConnection[]>([])
let lastConnection: ConnectionConfig | null = null
let readyPromise: Promise<void> | null = null
let locallyChanged = false
let connectionAttempt = 0
// High-water mark for connection numbers: a forgotten number is never reused.
let seqHighWater = 0

export interface SavedConnection extends ConnectionConfig {
  label: string
  /** Stable, never-reused number, addressable with `?connect=N`. */
  seq: number
}

function labelOf(cfg: ConnectionConfig): string {
  if (cfg.connectionString) {
    return cfg.connectionString.replace(/\/\/([^:]+):[^@]+@/, '//$1:***@')
  }
  return `${cfg.user ?? 'postgres'}@${cfg.host ?? 'localhost'}:${cfg.port ?? 5432}/${cfg.database ?? ''}`
}

/** A saved entry's connectable config, without the `label`/`seq` bookkeeping. */
function configOf(connection: SavedConnection): ConnectionConfig {
  if (connection.connectionString) return { connectionString: connection.connectionString }
  return {
    host: connection.host,
    port: connection.port,
    database: connection.database,
    user: connection.user,
    password: connection.password,
    ssl: connection.ssl,
  }
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
  const entries = value.filter((entry): entry is ConnectionConfig & { label: string; seq?: unknown } => {
    if (!entry || typeof entry !== 'object') return false
    const saved = entry as Record<string, unknown>
    return typeof saved.label === 'string' && isConnectionConfig(entry)
  })
  // Entries saved before numbering existed have no seq; fill those in while
  // preserving any number already assigned.
  return assignSeqs(entries)
}

function ensureReady(): Promise<void> {
  if (!readyPromise) {
    readyPromise = storageReady
      .then(({ connections }) => {
        if (locallyChanged || !connections) return
        savedConnections.splice(0, savedConnections.length, ...parseSavedConnections(connections.saved))
        lastConnection = isConnectionConfig(connections.last) ? { ...connections.last } : null
        const stored = connections.nextSeq
        const storedNext = typeof stored === 'number' && Number.isInteger(stored) && stored > 0 ? stored : 0
        seqHighWater = Math.max(storedNext, maxSeq(savedConnections))
      })
      .catch(() => undefined)
  }
  return readyPromise
}

function persist() {
  const saved = savedConnections.map((connection) => ({ ...connection }))
  const last = lastConnection ? { ...lastConnection } : null
  void ensureReady().then(() => saveConnections(saved, last, seqHighWater)).catch(() => undefined)
}

export function useConnection() {
  function saved(): SavedConnection[] {
    void ensureReady()
    return savedConnections
  }

  function remember(cfg: ConnectionConfig) {
    const label = labelOf(cfg)
    const existing = savedConnections.find((c) => c.label === label)
    if (!existing) seqHighWater += 1
    const seq = existing ? existing.seq : seqHighWater
    const list = savedConnections.filter((c) => c.label !== label)
    savedConnections.splice(0, savedConnections.length, { ...cfg, label, seq }, ...list.slice(0, 9))
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

  function forgetAll() {
    locallyChanged = true
    savedConnections.splice(0, savedConnections.length)
    lastConnection = null
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
      const { id, pgVersion } = await api.connect(body)
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
      state.pgVersion = pgVersion ?? ''
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
    if (state.id || state.connecting) return
    const requested = typeof window === 'undefined' ? null : parseConnectNumber(window.location.search)
    if (requested !== null) {
      const target = savedConnections.find((connection) => connection.seq === requested)
      if (target) {
        // A deep link connects for this session only; it does not replace the
        // remembered last connection used by a normal startup.
        await connect(configOf(target), false, true)
        if (!state.id) {
          state.dialog = true
          useToast().show(`Could not connect to #${requested}: ${state.error}`)
        }
        return
      }
      useToast().show(`No saved connection #${requested}`)
    }
    const cfg = lastConfig()
    if (!cfg) return
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
      // Best-effort cancel of in-flight queries; the destructive clear below
      // runs only after the server confirms the pool is closed. A failed
      // DELETE keeps the UI connected so a stale pool cannot linger behind a
      // phantom "not connected" badge.
      try {
        const { useResults } = await import('./results')
        const res = useResults()
        const runningKeys = Object.keys(res.state.byTab).filter((key) => {
          const r = res.state.byTab[key]
          return (r.running || r.loadingMore) && !r.cancelling
        })
        await Promise.all(runningKeys.map((key) => res.cancel(key, id).catch(() => undefined)))
      } catch {
        // ignore cleanup errors
      }
      if (attempt !== connectionAttempt) return
      try {
        await api.disconnect(id)
      } catch (err) {
        if (attempt !== connectionAttempt) return
        const message = err instanceof Error ? err.message : String(err)
        useToast().show(`Disconnect failed: ${message}`)
        return
      }
      if (attempt !== connectionAttempt) return
      try {
        const { useResults } = await import('./results')
        const res = useResults()
        for (const key of Object.keys(res.state.byTab)) res.drop(key)
      } catch {
        // ignore cleanup errors
      }
    }
    if (attempt !== connectionAttempt) return
    state.id = null
    state.label = ''
    state.pgVersion = ''
    useSchema().reset()
  }

  return { state, connect, disconnect, autoConnect, saved, forget, forgetAll, ready: ensureReady() }
}
