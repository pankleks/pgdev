<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import {
  CodeXml,
  Database,
  Eye,
  EyeOff,
  Lock,
  Plug,
  Power,
  Server,
  SlidersHorizontal,
  User,
  X,
} from 'lucide-vue-next'
import { useConnection, type SavedConnection } from '../composables/connection'
import type { ConnectionConfig } from '../types'

const conn = useConnection()
const saved = conn.saved()
const mode = ref<'params' | 'url'>('params')
const remember = ref(true)
const showPassword = ref(false)

const form = reactive<ConnectionConfig>({
  host: 'localhost',
  port: 5432,
  database: '',
  user: 'postgres',
  password: '',
  ssl: false,
})
const url = ref('')

const hasLeftColumn = computed(() => conn.state.id !== null || saved.length > 0)

interface ConnectionRow {
  label: string
  sub: string
  saved: SavedConnection | null
  /** Currently connected — highlighted, and its action is Disconnect. */
  active: boolean
}

/** Saved connections plus a synthetic row when connected without remembering. */
const allConnections = computed<ConnectionRow[]>(() => {
  const items: ConnectionRow[] = saved.map((c) => ({
    label: c.label,
    sub: c.connectionString ? 'connection string' : `${c.host}:${c.port} • ${c.database}`,
    saved: c,
    active: c.label === conn.state.label,
  }))
  if (conn.state.id && !items.some((item) => item.active)) {
    items.unshift({ label: conn.state.label, sub: '', saved: null, active: true })
  }
  return items
})

function pick(c: SavedConnection) {
  conn.state.error = ''
  if (c.connectionString) {
    mode.value = 'url'
    url.value = c.connectionString
  } else {
    mode.value = 'params'
    form.host = c.host ?? 'localhost'
    form.port = c.port ?? 5432
    form.database = c.database ?? ''
    form.user = c.user ?? 'postgres'
    form.password = c.password ?? ''
    form.ssl = c.ssl ?? false
  }
}

function drop(label: string) {
  conn.forget(label)
}

function clearAll() {
  if (!saved.length) return
  if (window.confirm('Forget all saved connections?')) conn.forgetAll()
}

async function submit() {
  if (mode.value === 'url' && !url.value.trim()) {
    conn.state.error = 'Connection string is required'
    return
  }
  const cfg: ConnectionConfig =
    mode.value === 'url'
      ? { connectionString: url.value.trim() }
      : { ...form, port: Number(form.port) || 5432 }
  await conn.connect(cfg, remember.value)
}
</script>

<template>
  <div class="modal-backdrop" @click.self="conn.state.dialog = false">
    <div class="modal connect-modal">
      <button class="icon connect-close" title="Close" @click="conn.state.dialog = false">
        <X :size="16" />
      </button>

      <div class="connect-head">
        <div class="connect-logo"><Database :size="30" /></div>
        <div>
          <h2>Connect to PostgreSQL</h2>
          <p class="connect-sub">Connect to a PostgreSQL database to explore and query your data.</p>
        </div>
      </div>

      <div class="connect-cols" :class="{ single: !hasLeftColumn }">
        <div v-if="hasLeftColumn" class="connect-panel">
          <div class="recent-head">
            <h3 class="panel-title">Connections</h3>
            <button v-if="saved.length" class="link" @click="clearAll">Clear all</button>
          </div>
          <div class="saved">
            <div
              v-for="c in allConnections"
              :key="c.label"
              class="saved-item"
              :class="{ current: c.active }"
              @click="c.saved && pick(c.saved)"
            >
              <Database class="saved-icon" :size="17" />
              <span class="saved-text">
                <strong>{{ c.label }}</strong>
                <small v-if="c.sub">{{ c.sub }}</small>
              </span>
              <!-- Tab-sized action buttons: disconnect for the active
                   connection, forget (X) for everything else. -->
              <button
                v-if="c.active"
                class="row-action disconnect"
                title="Disconnect"
                :disabled="conn.state.connecting"
                @click.stop="conn.disconnect()"
              >
                <Power :size="14" />
              </button>
              <button
                v-else-if="c.saved"
                class="row-action"
                title="Forget"
                @click.stop="drop(c.saved.label)"
              >
                <X :size="14" />
              </button>
            </div>
          </div>
        </div>

        <div class="connect-panel">
          <h3 class="panel-title">New connection</h3>

          <div class="seg" role="tablist">
            <button
              type="button"
              class="seg-btn"
              :class="{ active: mode === 'params' }"
              role="tab"
              :aria-selected="mode === 'params'"
              @click="mode = 'params'"
            >
              <SlidersHorizontal :size="14" /> Parameters
            </button>
            <button
              type="button"
              class="seg-btn"
              :class="{ active: mode === 'url' }"
              role="tab"
              :aria-selected="mode === 'url'"
              @click="mode = 'url'"
            >
              <CodeXml :size="14" /> Connection string
            </button>
          </div>

          <form v-if="mode === 'params'" class="fields" @submit.prevent="submit">
            <label class="field-label">
              <span>Host</span>
              <span class="field"><Server class="field-icon" :size="14" /><input v-model="form.host" /></span>
            </label>
            <label class="field-label">
              <span>Port</span>
              <span class="field"><input v-model.number="form.port" type="number" /></span>
            </label>
            <label class="field-label">
              <span>Database</span>
              <span class="field"><Database class="field-icon" :size="14" /><input v-model="form.database" required placeholder="postgres" /></span>
            </label>
            <label class="field-label">
              <span>User</span>
              <span class="field"><User class="field-icon" :size="14" /><input v-model="form.user" /></span>
            </label>
            <label class="field-label">
              <span>Password</span>
              <span class="field">
                <Lock class="field-icon" :size="14" />
                <input
                  v-model="form.password"
                  :type="showPassword ? 'text' : 'password'"
                  autocomplete="off"
                  placeholder="Enter password"
                />
                <button
                  type="button"
                  class="icon field-eye"
                  :title="showPassword ? 'Hide password' : 'Show password'"
                  @click.prevent="showPassword = !showPassword"
                >
                  <EyeOff v-if="showPassword" :size="14" />
                  <Eye v-else :size="14" />
                </button>
              </span>
            </label>

            <div class="checks">
              <label class="check-item">
                <input v-model="form.ssl" type="checkbox" />
                <span><strong>SSL</strong><small>Use SSL to connect to the database</small></span>
              </label>
              <label class="check-item">
                <input v-model="remember" type="checkbox" />
                <span><strong>Remember in this browser</strong><small>Save connection details locally</small></span>
              </label>
            </div>

            <button class="primary connect-btn" type="submit" :disabled="conn.state.connecting">
              <Plug :size="15" />
              {{ conn.state.connecting ? 'Connecting…' : 'Connect' }}
            </button>
          </form>

          <form v-else class="fields" @submit.prevent="submit">
            <label class="field-label">
              <span>URL</span>
              <span class="field"><input v-model="url" placeholder="postgres://user:pass@host:5432/db" /></span>
            </label>
            <div class="checks">
              <label class="check-item">
                <input v-model="remember" type="checkbox" />
                <span><strong>Remember in this browser</strong><small>Save connection details locally</small></span>
              </label>
            </div>
            <button class="primary connect-btn" type="submit" :disabled="conn.state.connecting">
              <Plug :size="15" />
              {{ conn.state.connecting ? 'Connecting…' : 'Connect' }}
            </button>
          </form>

          <div v-if="conn.state.error" class="error">{{ conn.state.error }}</div>
        </div>
      </div>
    </div>
  </div>
</template>
