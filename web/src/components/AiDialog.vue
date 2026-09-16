<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { Copy, X } from 'lucide-vue-next'
import { api } from '../api'
import { copyText } from '../lib/gridio'
import { useToast } from '../composables/toast'
import { useAi } from '../composables/ai'
import type { AiConfig } from '../types'

// AI agent access: everything an MCP client needs, plus what the agent may do.
// The token is stable per user (stored in ~/.config/pgdev/token; delete it to
// rotate) and only shown here, so the config is copy-paste ready.

const emit = defineEmits<{ close: [] }>()
const toast = useToast()
const ai = useAi()
const config = ref<AiConfig | null>(null)
const loading = ref(true)

onMounted(async () => {
  config.value = await api.aiConfig().catch(() => null)
  loading.value = false
  window.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.stopPropagation()
    emit('close')
  }
}

async function copyConfig() {
  if (!config.value) return
  const ok = await copyText(config.value.config)
  toast.show(ok ? 'MCP config copied.' : 'Copy to clipboard failed')
}
</script>

<template>
  <div class="modal-backdrop" @mousedown.self="emit('close')">
    <div class="modal ai-modal">
      <button class="icon ai-close" title="Close" @click="emit('close')"><X :size="16" /></button>

      <h2>AI agent access (MCP)</h2>

      <p v-if="loading" class="ai-note">Loading…</p>

      <template v-else-if="config">
        <p class="ai-note">
          Point an MCP client (opencode, Claude Desktop, …) at pgDEV with the config below.
          The agent can read the schema and run <strong>read-only</strong> queries; SQL that
          writes is only written into a tab for you to review and run.
        </p>

        <dl class="ai-facts">
          <dt>MCP server</dt>
          <dd class="mono">{{ config.command }}</dd>
          <dt>URL</dt>
          <dd class="mono">{{ config.url }}</dd>
          <dt>Token</dt>
          <dd class="mono">{{ config.token }}</dd>
          <dt>Window</dt>
          <dd>{{ ai.state.connected ? 'connected' : 'not connected' }}</dd>
          <dt>Agent rows</dt>
          <dd>first {{ config.limits.maxRows }} rows / {{ Math.round(config.limits.maxBytes / 1024) }} KB per result</dd>
        </dl>

        <pre class="ai-config">{{ config.config }}</pre>

        <div class="ai-actions">
          <button class="primary" @click="copyConfig"><Copy :size="14" /> COPY CONFIG</button>
        </div>
      </template>
    </div>
  </div>
</template>
