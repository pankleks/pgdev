import { reactive } from 'vue'
import { api } from '../api'
import type { ConnectionConfig } from '../types'
import { useSchema } from './schema'
import { useToast } from './toast'

const state = reactive({
  id: null as string | null,
  label: '',
  dialog: false,
  connecting: false,
  error: '',
})

const SAVED_KEY = 'pgdev.savedConnections'
const LAST_KEY = 'pgdev.lastConnection'
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

export function useConnection() {
  function saved(): SavedConnection[] {
    try {
      const raw = localStorage.getItem(SAVED_KEY)
      return raw ? (JSON.parse(raw) as SavedConnection[]) : []
    } catch {
      return []
    }
  }

  function remember(cfg: ConnectionConfig) {
    const label = labelOf(cfg)
    const list = saved().filter((c) => c.label !== label)
    list.unshift({ ...cfg, label })
    localStorage.setItem(SAVED_KEY, JSON.stringify(list.slice(0, 10)))
  }

  function rememberLast(cfg: ConnectionConfig) {
    localStorage.setItem(LAST_KEY, JSON.stringify(cfg))
  }

  function lastConfig(): ConnectionConfig | null {
    try {
      const raw = localStorage.getItem(LAST_KEY)
      if (raw) return JSON.parse(raw) as ConnectionConfig
      const list = saved()
      return list.length ? ({ ...list[0] } as ConnectionConfig) : null
    } catch {
      return null
    }
  }

  function forget(label: string) {
    localStorage.setItem(SAVED_KEY, JSON.stringify(saved().filter((c) => c.label !== label)))
    try {
      const raw = localStorage.getItem(LAST_KEY)
      if (raw && labelOf(JSON.parse(raw) as ConnectionConfig) === label) localStorage.removeItem(LAST_KEY)
    } catch {
      // Ignore malformed old storage.
    }
  }

  async function connect(cfg: ConnectionConfig, save: boolean, preserveLast = false) {
    const attempt = ++connectionAttempt
    state.connecting = true
    state.error = ''
    try {
      const prevId = state.id
      const { id } = await api.connect(cfg)
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
        remember(cfg)
        rememberLast(cfg)
      } else if (!preserveLast) {
        localStorage.removeItem(LAST_KEY)
      }
      await useSchema().load(id)
    } catch (e) {
      if (attempt === connectionAttempt) state.error = (e as Error).message
    } finally {
      if (attempt === connectionAttempt) state.connecting = false
    }
  }

  async function autoConnect() {
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

  return { state, connect, disconnect, autoConnect, saved, forget }
}
