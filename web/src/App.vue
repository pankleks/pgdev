<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, provide, ref, watch } from 'vue'
import { Database, FileOutput, FilePlus2, FolderOpen, PanelLeftClose, PanelLeftOpen, Save, Settings, SlidersHorizontal, Wand2, X } from 'lucide-vue-next'
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
import { useAi } from './composables/ai'
import { api } from './api'
import { getActiveSelection, triggerFormat, triggerParamMap } from './lib/formatbridge'
import { isPickerCancelled, openTextFiles, saveTextFile } from './lib/files'

const conn = useConnection()
const tabs = useTabs()
const results = useResults()
const settings = useSettings()
const toast = useToast()
const ai = useAi()
const settingsOpen = ref(false)
const paramBar = ref(false)
const paramValuesText = ref('')
const paramInput = ref<HTMLInputElement | null>(null)
const saving = ref(false)
const version = ref('')

// Fetched once so support can ask "which build?" without a terminal.
void api.version().then((v) => { version.value = v }).catch(() => undefined)

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
const sideCollapsed = ref(false)
let dragKind: 'side' | 'results' | null = null

// Panel sizes persist per browser: saved values land once settings load, and
// drags are written back debounced (flushed on pagehide so a quick resize
// before closing is not lost). The collapse flag rides along.
void settings.ready.then(() => {
  sideW.value = settings.state.panelSizes.sideW
  resultsH.value = settings.state.panelSizes.resultsH
  sideCollapsed.value = settings.state.sideCollapsed
})

/** Hide the navigation panel entirely; the topbar toggle brings it back. */
function toggleSide() {
  sideCollapsed.value = !sideCollapsed.value
  settings.setSideCollapsed(sideCollapsed.value)
}

let sizesTimer = 0
function persistSizes() {
  window.clearTimeout(sizesTimer)
  sizesTimer = window.setTimeout(() => settings.setPanelSizes(sideW.value, resultsH.value), 300)
}
watch([sideW, resultsH], persistSizes)
// Focus the values input as soon as the bar opens, so pasting works at once.
watch(paramBar, (open) => {
  if (open) void nextTick(() => paramInput.value?.focus())
})
function flushSizes() {
  window.clearTimeout(sizesTimer)
  settings.setPanelSizes(sideW.value, resultsH.value)
}

function startDrag(e: PointerEvent, kind: 'side' | 'results') {
  dragKind = kind
  // Keep the drag (and the resize cursor) alive even when the pointer leaves
  // the window; without capture a release outside sticks the drag on.
  try {
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  } catch {
    // Pointer capture is a progressive enhancement; window listeners suffice.
  }
  // Suppress text selection under the pointer for the whole drag.
  document.body.classList.add(kind === 'side' ? 'dragging-side' : 'dragging-results')
}

function onMouseUp() {
  dragKind = null
  document.body.classList.remove('dragging-side', 'dragging-results')
}

function onMouseMove(e: PointerEvent) {
  if (dragKind === 'side') {
    sideW.value = Math.min(640, Math.max(180, e.clientX))
  } else if (dragKind === 'results') {
    resultsH.value = Math.min(window.innerHeight - 220, Math.max(80, window.innerHeight - e.clientY))
  }
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
  window.addEventListener('pointermove', onMouseMove)
  window.addEventListener('pointerup', onMouseUp)
  window.addEventListener('pointercancel', onMouseUp)
  window.addEventListener('pagehide', flushSizes)
  // Capture editor shortcuts before Monaco or the browser handles them.
  window.addEventListener('keydown', onKeyDown, true)
  // Subscribe to the AI bridge as soon as the app loads: the agent can then
  // reach the editor whether or not a database connection is open yet.
  void ai.start()
  // Restore the saved tab session before the default tab is created, then
  // connect. The session is global: connection state plays no part in it.
  void tabs.sessionsReady
    .then(() => {
      if (!tabs.state.tabs.length) tabs.newQuery()
      return Promise.all([conn.ready, settings.ready, tabs.pinsReady])
    })
    .then(() => conn.autoConnect())
})

onBeforeUnmount(() => {
  window.removeEventListener('pointermove', onMouseMove)
  window.removeEventListener('pointerup', onMouseUp)
  window.removeEventListener('pointercancel', onMouseUp)
  window.removeEventListener('pagehide', flushSizes)
  window.removeEventListener('keydown', onKeyDown, true)
})

/**
 * The prepare button opens the optional-values bar; applying it (Enter or the
 * Apply button) generates the script. An empty input keeps the inferred
 * placeholder values, so the previous direct-generation flow still works.
 */
function toggleParamBar() {
  paramBar.value = !paramBar.value
  if (paramBar.value) paramValuesText.value = ''
}

function applyParamValues() {
  const text = paramValuesText.value.trim()
  paramBar.value = false
  paramValuesText.value = ''
  triggerParamMap(text || undefined)
}

function runActive() {  if (!conn.state.id) {
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
  // Connection-bound SQL must not run against a different database after a
  // connection switch.
  if (tab.connectionId && tab.connectionId !== conn.state.id) {
    toast.show('This SQL belongs to another connection — re-open it to run against the current database')
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
        class="icon"
        :title="sideCollapsed ? 'Expand navigation panel' : 'Collapse navigation panel'"
        @click="toggleSide()"
      ><component :is="sideCollapsed ? PanelLeftOpen : PanelLeftClose" :size="15" /></button>
      <button
        v-if="conn.state.id"
        class="conn-badge"
        title="Connection details, disconnect, or switch"
        @click="conn.state.dialog = true"
      >{{ conn.state.label }}</button>
      <button v-else class="conn-badge off" title="Open the connection dialog" @click="conn.state.dialog = true">not connected</button>
      <span class="spacer" />
      <button
        class="icon"
        title="Format SQL or selection (Ctrl+Shift+F)"
        :disabled="!activeTab || activeTab.readOnly"
        @click="triggerFormat()"
      ><Wand2 :size="15" /></button>
      <button
        class="icon"
        title="Build a PREPARE / EXECUTE template from $N parameters"
        :disabled="!activeTab || activeTab.readOnly"
        @click="toggleParamBar()"
      ><SlidersHorizontal :size="15" /></button>
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
      <button class="icon" title="Settings" @click="settingsOpen = true"><Settings :size="15" /></button>
      <a
        v-if="version"
        class="app-version"
        href="https://github.com/pankleks/pgdev"
        target="_blank"
        rel="noopener noreferrer"
        title="Open the pgDEV project page on GitHub"
      >{{ version }}</a>
    </header>
    <input
      ref="fileInput"
      type="file"
      accept=".sql,.txt,.ddl"
      multiple
      style="display: none"
      @change="onFilesChosen"
    />

    <div v-if="paramBar" class="param-bar">
      <SlidersHorizontal :size="13" class="param-bar-icon" />
      <input
        ref="paramInput"
        v-model="paramValuesText"
        type="text"
        spellcheck="false"
        placeholder='Optional values as a JSON array — e.g. [1, "text", [10, 12], false, null] · Enter to apply'
        @keydown.enter.prevent="applyParamValues()"
        @keydown.esc.prevent="paramBar = false"
      />
      <button class="btn-sm primary" title="Apply values to the generated script" @click="applyParamValues()">Apply</button>
      <button class="icon" title="Close" @click="paramBar = false"><X :size="14" /></button>
    </div>

    <div class="body">
      <aside v-show="!sideCollapsed" class="sidebar" :style="{ width: sideW + 'px' }">
        <ObjectBrowser />
      </aside>
      <div v-if="!sideCollapsed" class="drag-v" @pointerdown.prevent="startDrag($event, 'side')" />
      <main class="pgdev-main">
        <section class="editor-area">
          <EditorTabs />
        </section>
        <div class="drag-h" @pointerdown.prevent="startDrag($event, 'results')" />
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
