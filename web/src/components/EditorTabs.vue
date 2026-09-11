<script setup lang="ts">
import { computed, ref } from 'vue'
import { FilePlus2, FolderOpen, X } from 'lucide-vue-next'
import { useTabs } from '../composables/tabs'
import QueryEditor from './QueryEditor.vue'

const tabs = useTabs()
const active = computed(
  () => tabs.state.tabs.find((t) => t.key === tabs.state.activeKey) ?? null,
)
const fileInput = ref<HTMLInputElement | null>(null)

async function onFilesChosen(e: Event) {
  const input = e.target as HTMLInputElement
  for (const file of [...(input.files ?? [])]) {
    tabs.openFile(file.name, await file.text())
  }
  input.value = ''
}
</script>

<template>
  <div class="editor-tabs">
    <div class="tabstrip">
      <input
        ref="fileInput"
        type="file"
        accept=".sql,.txt,.ddl"
        multiple
        style="display: none"
        @change="onFilesChosen"
      />
      <div
        v-for="t in tabs.state.tabs"
        :key="t.key"
        class="tab"
        :class="{ active: t.key === tabs.state.activeKey }"
        @click="tabs.activate(t.key)"
      >
        <span class="tab-title">{{ t.title }}</span>
        <button class="tab-close" title="Close tab" @click.stop="tabs.close(t.key)"><X :size="14" /></button>
      </div>
      <button class="tab-add" title="Open .sql file" @click="fileInput?.click()"><FolderOpen :size="15" /></button>
      <button class="tab-add" title="New query tab" @click="tabs.newQuery()"><FilePlus2 :size="15" /></button>
    </div>
    <QueryEditor v-if="active" :tab="active" />
    <div v-else class="editor-empty">
      <p>No open tabs</p>
      <button class="primary" @click="tabs.newQuery()">New query</button>
    </div>
  </div>
</template>
