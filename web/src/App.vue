<script setup lang="ts">
import { onBeforeUnmount, onMounted, provide, ref } from 'vue'
import { Database } from 'lucide-vue-next'
import ConnectDialog from './components/ConnectDialog.vue'
import ObjectBrowser from './components/ObjectBrowser.vue'
import EditorTabs from './components/EditorTabs.vue'
import ResultsPanel from './components/ResultsPanel.vue'
import { useConnection } from './composables/connection'
import { useTabs } from './composables/tabs'
import { useResults } from './composables/results'
import { useToast } from './composables/toast'
import { getActiveSelection } from './lib/formatbridge'

const conn = useConnection()
const tabs = useTabs()
const results = useResults()
const toast = useToast()

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

onMounted(() => {
  window.addEventListener('mousemove', onMouseMove)
  window.addEventListener('mouseup', onMouseUp)
  if (!tabs.state.tabs.length) tabs.newQuery()
  conn.autoConnect()
})

onBeforeUnmount(() => {
  window.removeEventListener('mousemove', onMouseMove)
  window.removeEventListener('mouseup', onMouseUp)
})

function runActive() {
  if (!conn.state.id) {
    toast.show('Connect to a database first')
    conn.state.dialog = true
    return
  }
  const tab = tabs.state.tabs.find((t) => t.key === tabs.state.activeKey)
  if (tab && !tab.readOnly) {
    const selected = getActiveSelection()
    results.run(tab.key, conn.state.id, selected?.trim() ? selected : tab.content)
  }
}

provide('pgdev:run', runActive)
</script>

<template>
  <div class="app">
    <header class="topbar">
      <span class="logo"><Database :size="15" /> pgdev</span>
      <span v-if="conn.state.id" class="conn-badge">{{ conn.state.label }}</span>
      <span v-else class="conn-badge off">not connected</span>
      <span class="spacer" />
      <button v-if="conn.state.id" @click="conn.disconnect()">Disconnect</button>
      <button v-else class="primary" @click="conn.state.dialog = true">Connect</button>
    </header>

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
    <div v-if="toast.state.visible" class="toast">{{ toast.state.text }}</div>
  </div>
</template>
