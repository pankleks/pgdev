<script setup lang="ts">
import { reactive, ref } from 'vue'
import { useConnection, type SavedConnection } from '../composables/connection'
import type { ConnectionConfig } from '../types'

const conn = useConnection()
const saved = ref<SavedConnection[]>(conn.saved())
const mode = ref<'params' | 'url'>('params')
const remember = ref(true)

const form = reactive<ConnectionConfig>({
  host: 'localhost',
  port: 5432,
  database: '',
  user: 'postgres',
  password: '',
  ssl: false,
})
const url = ref('')

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
  saved.value = conn.saved()
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
  // Refresh the list so a newly saved connection shows without reopening.
  saved.value = conn.saved()
}
</script>

<template>
  <div class="modal-backdrop" @click.self="conn.state.dialog = false">
    <div class="modal">
      <h2>Connect to PostgreSQL</h2>

      <div v-if="saved.length" class="saved">
        <div v-for="c in saved" :key="c.label" class="saved-item" @click="pick(c)">
          <span>{{ c.label }}</span>
          <button class="icon" title="Forget" @click.stop="drop(c.label)">×</button>
        </div>
      </div>

      <div class="mode-switch">
        <label><input v-model="mode" type="radio" value="params" /> Parameters</label>
        <label><input v-model="mode" type="radio" value="url" /> Connection string</label>
      </div>

      <form v-if="mode === 'params'" class="fields" @submit.prevent="submit">
        <label>Host <input v-model="form.host" /></label>
        <label>Port <input v-model.number="form.port" type="number" /></label>
        <label>Database <input v-model="form.database" required placeholder="postgres" /></label>
        <label>User <input v-model="form.user" /></label>
        <label>Password <input v-model="form.password" type="password" autocomplete="off" /></label>
        <label class="check"><input v-model="form.ssl" type="checkbox" /> SSL</label>
        <label class="check"><input v-model="remember" type="checkbox" /> Remember in this browser</label>
        <button class="primary" type="submit" :disabled="conn.state.connecting">
          {{ conn.state.connecting ? 'Connecting…' : 'Connect' }}
        </button>
      </form>

      <form v-else class="fields" @submit.prevent="submit">
        <label>URL <input v-model="url" required placeholder="postgres://user:pass@host:5432/db" /></label>
        <label class="check"><input v-model="remember" type="checkbox" /> Remember in this browser</label>
        <button class="primary" type="submit" :disabled="conn.state.connecting">
          {{ conn.state.connecting ? 'Connecting…' : 'Connect' }}
        </button>
      </form>

      <div v-if="conn.state.error" class="error">{{ conn.state.error }}</div>
    </div>
  </div>
</template>
