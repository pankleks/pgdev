<script setup lang="ts">
import { computed, ref } from 'vue'
import { Copy, RotateCcw, X } from 'lucide-vue-next'
import { api } from '../api'
import { useAi } from '../composables/ai'
import { useSettings } from '../composables/settings'
import { useToast } from '../composables/toast'
import { copyText } from '../lib/gridio'
import Stepper from './Stepper.vue'
import Toggle from './Toggle.vue'

const emit = defineEmits<{ close: [] }>()
const settings = useSettings()
const ai = useAi()
const toast = useToast()
const copyingConfig = ref(false)

const groupObjects = computed({
  get: () => settings.state.groupObjects,
  set: (enabled: boolean) => settings.setGroupObjects(enabled),
})

const statementTimeout = computed({
  get: () => settings.state.statementTimeout,
  set: (seconds: number) => settings.setStatementTimeout(Number(seconds)),
})

const editorFontSize = computed({
  get: () => settings.state.editorFontSize,
  set: (px: number) => settings.setEditorFontSize(Number(px)),
})

const aiLimitRows = computed({
  get: () => settings.state.aiLimitRows,
  set: (rows: number) => {
    settings.setAiLimitRows(Number(rows))
    void ai.pushLimits()
  },
})

const aiLimitKb = computed({
  get: () => settings.state.aiLimitKb,
  set: (kb: number) => {
    settings.setAiLimitKb(Number(kb))
    void ai.pushLimits()
  },
})

function reset() {
  settings.resetToDefaults()
  void ai.pushLimits()
}

/** Put the copy-paste-ready MCP client config on the clipboard. */
async function copyMcpConfig() {
  if (copyingConfig.value) return
  copyingConfig.value = true
  try {
    const config = await api.aiConfig()
    const ok = await copyText(config.config)
    toast.show(ok ? 'MCP config copied.' : 'Copy to clipboard failed')
  } catch {
    toast.show('Could not load the MCP config')
  } finally {
    copyingConfig.value = false
  }
}

function close() {
  emit('close')
}
</script>

<template>
  <div class="modal-backdrop" @click.self="close">
    <div class="modal settings-modal">
      <div class="settings-head">
        <div>
          <h2>Settings</h2>          
        </div>
        <button class="icon" title="Close" @click="close"><X :size="17" /></button>
      </div>

      <section class="settings-section">
        <h3>Editor</h3>
        <div class="setting-row">
          <div class="setting-text">
            <strong>Font size</strong>
            <small>Size of text in the query editor.</small>
          </div>
          <Stepper v-model="editorFontSize" :min="8" :max="32" unit="px" />
        </div>
      </section>

      <section class="settings-section">
        <h3>Query execution</h3>
        <div class="setting-row">
          <div class="setting-text">
            <strong>Statement timeout</strong>
            <small>Cancel queries exceeding this duration. Changes apply to new connections.</small>
          </div>
          <Stepper v-model="statementTimeout" :min="1" :max="600" unit="s" />
        </div>
      </section>

      <section class="settings-section">
        <h3>AI agent</h3>
        <div class="setting-row">
          <div class="setting-text">
            <strong>Row limit</strong>
            <small>How many rows of each result set an MCP agent may read.</small>
          </div>
          <Stepper v-model="aiLimitRows" :min="1" :max="10000" unit="rows" />
        </div>
        <div class="setting-row">
          <div class="setting-text">
            <strong>Size limit</strong>
            <small>Byte budget of the rows an MCP agent may read per result set.</small>
          </div>
          <Stepper v-model="aiLimitKb" :min="1" :max="4096" unit="KB" />
        </div>
        <div class="setting-row">
          <div class="setting-text">
            <strong>MCP config</strong>
            <small>Copy the JSON config for an MCP client (opencode, Claude Desktop, …). The agent can read the schema, run read-only queries, and stage writes in a tab for you to run.</small>
          </div>
          <button class="btn-sm primary" :disabled="copyingConfig" @click="copyMcpConfig">
            <Copy :size="13" /> COPY
          </button>
        </div>
      </section>

      <section class="settings-section">
        <h3>Object browser</h3>
        <div class="setting-row">
          <div class="setting-text">
            <strong>Group objects</strong>
            <small>Group related tables, views, functions, and types by common name prefixes.</small>
          </div>
          <Toggle v-model="groupObjects" />
        </div>
      </section>

      <div class="settings-foot">
        <button class="reset-link" title="Restore every setting to its default" @click="reset">
          <RotateCcw :size="14" /> Reset to defaults
        </button>
      </div>
    </div>
  </div>
</template>
