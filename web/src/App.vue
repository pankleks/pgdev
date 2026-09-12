<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, provide, ref } from 'vue'
import { Database, FileOutput, FilePlus2, FolderOpen, Save, Settings, Wand2 } from 'lucide-vue-next'
import ConnectDialog from './components/ConnectDialog.vue'
import SettingsDialog from './components/SettingsDialog.vue'
import ObjectBrowser from './components/ObjectBrowser.vue'
import EditorTabs from './components/EditorTabs.vue'
import ResultsPanel from './components/ResultsPanel.vue'
import { useConnection } from './composables/connection'
import { useTabs, type EditorTab } from './composables/tabs'
import { useResults } from './composables/results'
import { useSettings } from './composables/settings'
import { useToast } from './composables/toast'
import { getActiveSelection, triggerFormat } from './lib/formatbridge'
import { isPickerCancelled, openTextFiles, saveTextFile } from './lib/files'

const conn = useConnection()
const tabs = useTabs()
const results = useResults()
const settings = useSettings()
const toast = useToast()
const settingsOpen = ref(false)
const saving = ref(false)

const activeTab = computed(() =>
  tabs.state.tabs.find((t) => t.key === tabs.state.activeKey) ?? null,
)

const fileInput = ref<HTMLInputElement | null>(null)

function suggestedFileName(tab: EditorTab): string {
  const base = (tab.fileName ?? tab.title)
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/[. ]+$/, '') || 'query'
  return /\.[^./\\]+$/.test(base) ? base : `${base}.sql`
}

async function onFilesChosen(e: Event) {
  const input = e.target as HTMLInputElement
  for (const file of [...(input.files ?? [])]) {
    tabs.openFile(file.name, await file.text())
  }
  input.value = ''
}

async function openFiles() {
  try {
    const picked = await openTextFiles()
    if (picked === null) {
      fileInput.value?.click()
      return
    }
    for (const { file, handle } of picked) tabs.openFile(file.name, await file.text(), handle)
  } catch (e) {
    if (!isPickerCancelled(e)) toast.show(`Open failed: ${(e as Error).message}`)
  }
}

async function saveActive(saveAs = false) {
  const tab = activeTab.value
  if (!tab || saving.value) return
  const key = tab.key
  const pinnedId = tab.pinnedId
  const content = tab.content
  const fileName = suggestedFileName(tab)
  const handle = tabs.fileHandle(key)
  const pickName = saveAs || tab.source === 'untitled'
  saving.value = true
  try {
    const saved = await saveTextFile(content, fileName, handle, pickName)
    if (saved) {
      if (tabs.state.tabs.some((entry) => entry.key === key)) {
        tabs.markSaved(key, saved.fileName, saved.handle, content)
      } else if (pinnedId) {
        tabs.markPinnedSaved(pinnedId, saved.fileName, content, saved.handle)
      }
    }
  } catch (e) {
    if (!isPickerCancelled(e)) toast.show(`Save failed: ${(e as Error).message}`)
  } finally {
    saving.value = false
  }
}

const sideW = ref(336)
const resultsH = ref(240)
let dragKind: 'side' | 'results' | null = null

function onMouseMove(e: MouseEvent) {
  if (dragKind === 'side') {
    sideW.value = Math.min(640, Math.max(180, e.clientX))
  } else if (dragKind === 'results') {
    resultsH.value = Math.min(window.innerHeight - 220, Math.max(80, window.innerHeight - e.clientY))
  }
}

function onMouseUp() {
  dragKind = null
}

function onKeyDown(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.code === 'KeyS') {
    e.preventDefault()
    void saveActive()
    return
  }
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.code === 'KeyO') {
    e.preventDefault()
    void openFiles()
    return
  }
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.code === 'KeyN') {
    e.preventDefault()
    tabs.newQuery()
  }
}

onMounted(() => {
  window.addEventListener('mousemove', onMouseMove)
  window.addEventListener('mouseup', onMouseUp)
  // Capture editor shortcuts before Monaco or the browser handles them.
  window.addEventListener('keydown', onKeyDown, true)
  if (!tabs.state.tabs.length) tabs.newQuery()
  void Promise.all([conn.ready, settings.ready, tabs.pinsReady]).then(() => conn.autoConnect())
})

onBeforeUnmount(() => {
  window.removeEventListener('mousemove', onMouseMove)
  window.removeEventListener('mouseup', onMouseUp)
  window.removeEventListener('keydown', onKeyDown, true)
})

function runActive() {
  if (!conn.state.id) {
    toast.show('Connect to a database first')
    conn.state.dialog = true
    return
  }
  const tab = tabs.state.tabs.find((t) => t.key === tabs.state.activeKey)
  if (!tab) {
    toast.show('No active tab')
    return
  }
  if (tab.readOnly) {
    toast.show('DDL preview is read-only')
    return
  }
  // DDL is bound to the connection it was generated from; running it after a
  // connection switch would execute against the wrong database.
  if (tab.connectionId && tab.connectionId !== conn.state.id) {
    toast.show('This DDL came from another connection — re-open it to run against the current database')
    return
  }
  const existing = results.state.byTab[tab.key]
   if (existing?.running || existing?.loadingMore) {
     toast.show(
       existing.loadingMore
         ? 'Rows are still loading…'
         : existing.cancelling
           ? 'Query is being canceled…'
           : 'Query already running',
     )
    return
  }
  const selected = getActiveSelection()
  const sql = selected?.trim() ? selected : tab.content
  if (!sql.trim()) {
    toast.show('Nothing to run')
    return
  }
  results.run(tab.key, conn.state.id, sql)
}

provide('pgdev:run', runActive)
</script>

<template>
  <div class="app">
    <header class="topbar">
      <span class="logo"><Database :size="15" /> pgDEV</span>
      <button
        v-if="conn.state.id"
        class="conn-badge"
        title="Switch connection"
        @click="conn.state.dialog = true"
      >{{ conn.state.label }}</button>
      <span v-else class="conn-badge off">not connected</span>
      <span class="spacer" />
      <button
        class="icon"
        title="Format SQL or selection (Ctrl+Shift+F)"
        :disabled="!activeTab || activeTab.readOnly"
        @click="triggerFormat()"
      ><Wand2 :size="15" /></button>
      <button class="icon" title="New query tab (Ctrl+N)" @click="tabs.newQuery()"><FilePlus2 :size="15" /></button>
      <button class="icon" title="Open .sql file (Ctrl+O)" @click="openFiles()"><FolderOpen :size="15" /></button>
      <button
        class="icon"
        :disabled="!activeTab || saving"
        :title="saving ? 'Saving…' : 'Save active tab (Ctrl+S)'"
        :aria-label="saving ? 'Saving' : 'Save active tab'"
        @click="saveActive()"
      ><Save :size="15" /></button>
      <button
        class="icon"
        :disabled="!activeTab || saving"
        title="Save active tab as a new SQL file"
        aria-label="Save active tab as a new SQL file"
        @click="saveActive(true)"
      ><FileOutput :size="15" /></button>
      <button v-if="conn.state.id" @click="conn.disconnect()">Disconnect</button>
      <button v-else class="primary" @click="conn.state.dialog = true">Connect</button>
      <button class="icon" title="Settings" @click="settingsOpen = true"><Settings :size="15" /></button>
    </header>
    <input
      ref="fileInput"
      type="file"
      accept=".sql,.txt,.ddl"
      multiple
      style="display: none"
      @change="onFilesChosen"
    />

    <div class="body">
      <aside class="sidebar" :style="{ width: sideW + 'px' }">
        <ObjectBrowser />
      </aside>
      <div class="drag-v" @mousedown="dragKind = 'side'" />
      <main class="pgdev-main">
        <section class="editor-area">
          <EditorTabs />
        </section>
        <div class="drag-h" @mousedown="dragKind = 'results'" />
        <section class="results-area" :style="{ height: resultsH + 'px' }">
          <ResultsPanel />
        </section>
      </main>
    </div>

    <ConnectDialog v-if="conn.state.dialog" />
    <SettingsDialog v-if="settingsOpen" @close="settingsOpen = false" />
    <div v-if="toast.state.visible" class="toast">{{ toast.state.text }}</div>
  </div>
</template>
