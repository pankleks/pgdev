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
  }

  async function connect(cfg: ConnectionConfig, save: boolean) {
    state.connecting = true
    state.error = ''
    try {
      const prevId = state.id
      const { id } = await api.connect(cfg)
      if (prevId && prevId !== id) {
        // Switching connections from the badge dialog: close the old pool
        // and drop its per-tab results so stale data isn't shown.
        await api.disconnect(prevId).catch(() => {})
        try {
          const { useResults } = await import('./results')
          const res = useResults()
          for (const key of Object.keys(res.state.byTab)) res.drop(key)
        } catch {
          // ignore cleanup errors
        }
      }
      state.id = id
      state.label = labelOf(cfg)
      state.dialog = false
      if (save) remember(cfg)
      rememberLast(cfg)
      await useSchema().load(id)
    } catch (e) {
      state.error = (e as Error).message
    } finally {
      state.connecting = false
    }
  }

  async function autoConnect() {
    const cfg = lastConfig()
    if (!cfg || state.id) return
    await connect(cfg, false)
    if (!state.id) {
      state.dialog = true
      useToast().show(`Auto-connect failed: ${state.error}`)
    }
  }

  async function disconnect() {
    const id = state.id
    if (id) {
      // Best-effort cancel of in-flight queries, then close the pool.
      try {
        const { useResults } = await import('./results')
        const res = useResults()
        const runningKeys = Object.keys(res.state.byTab).filter((key) => {
          const r = res.state.byTab[key]
          return r.running && !r.cancelling
        })
        await Promise.all(runningKeys.map((key) => res.cancel(key, id).catch(() => undefined)))
        for (const key of Object.keys(res.state.byTab)) res.drop(key)
      } catch {
        // ignore cleanup errors
      }
      await api.disconnect(id).catch(() => {})
    }
    state.id = null
    state.label = ''
    useSchema().reset()
  }

  return { state, connect, disconnect, autoConnect, saved, forget }
}
