<script setup lang="ts">
import { computed } from 'vue'
import { X } from 'lucide-vue-next'
import { useSettings } from '../composables/settings'

const emit = defineEmits<{ close: [] }>()
const settings = useSettings()

const groupObjects = computed({
  get: () => settings.state.groupObjects,
  set: (enabled: boolean) => settings.setGroupObjects(enabled),
})

function close() {
  emit('close')
}
</script>

<template>
  <div class="modal-backdrop" @click.self="close">
    <div class="modal settings-modal">
      <div class="modal-title">
        <h2>Settings</h2>
        <button class="icon" title="Close" @click="close"><X :size="15" /></button>
      </div>

      <section class="settings-section">
        <h3>Object Browser</h3>
        <label class="setting-row">
          <input v-model="groupObjects" type="checkbox" />
          <span>
            <strong>Group objects</strong>
            <small>Group related tables, views, functions, and types by common name prefixes.</small>
          </span>
        </label>
      </section>
    </div>
  </div>
</template>
