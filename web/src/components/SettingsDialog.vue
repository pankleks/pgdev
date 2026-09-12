<script setup lang="ts">
import { computed } from 'vue'
import { RotateCcw, X } from 'lucide-vue-next'
import { useSettings } from '../composables/settings'
import Stepper from './Stepper.vue'
import Toggle from './Toggle.vue'

const emit = defineEmits<{ close: [] }>()
const settings = useSettings()

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

function reset() {
  settings.resetToDefaults()
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
          <p class="settings-sub">Configure editor and query behavior.</p>
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
