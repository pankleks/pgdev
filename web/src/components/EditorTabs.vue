<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { X } from 'lucide-vue-next'
import { useTabs, type EditorTab } from '../composables/tabs'
import { useConnection } from '../composables/connection'
import { useResults } from '../composables/results'
import { api } from '../api'
import QueryEditor from './QueryEditor.vue'

const tabs = useTabs()
const conn = useConnection()
const results = useResults()
const active = computed(
  () => tabs.state.tabs.find((t) => t.key === tabs.state.activeKey) ?? null,
)

const menu = ref<{ x: number; y: number; tabKey: string } | null>(null)

function openMenu(e: MouseEvent, tabKey: string) {
  e.preventDefault()
  const w = 190
  const tab = tabs.state.tabs.find((t) => t.key === tabKey)
  const h = tab?.source === 'file' ? 150 : 120
  menu.value = {
    x: Math.min(e.clientX, window.innerWidth - w - 8),
    y: Math.min(e.clientY, window.innerHeight - h - 8),
    tabKey,
  }
}

function togglePin(key: string) {
  const tab = tabs.state.tabs.find((entry) => entry.key === key)
  if (!tab || tab.source !== 'file') return
  if (tab.pinnedId && tabs.isPinned(key)) {
    void tabs.unpinFile(tab.pinnedId)
  } else {
    void tabs.pinTab(key)
  }
}

function menuItem(action: () => void) {
  action()
  menu.value = null
}

function closeSession(key: string) {
  results.drop(key)
  if (conn.state.id) void api.closeSession(conn.state.id, key).catch(() => undefined)
}

function canClose(tab: EditorTab): boolean {
  return !tabs.isDirty(tab) || window.confirm(`Close unsaved changes in "${tab.title}"?`)
}

function closeTab(key: string) {
  const tab = tabs.state.tabs.find((t) => t.key === key)
  if (!tab || !canClose(tab)) return
  closeSession(key)
  tabs.close(key)
}

function closeAllTabs() {
  const openTabs = [...tabs.state.tabs]
  if (openTabs.some((tab) => !canClose(tab))) return
  for (const tab of openTabs) closeSession(tab.key)
  tabs.closeAll()
}

function closeOtherTabs(key: string) {
  const toClose = tabs.state.tabs.filter((tab) => tab.key !== key)
  if (toClose.some((tab) => !canClose(tab))) return
  for (const tab of toClose) closeSession(tab.key)
  tabs.closeOthers(key)
}

function closeRightTabs(key: string) {
  const index = tabs.state.tabs.findIndex((tab) => tab.key === key)
  if (index === -1) return
  const toClose = tabs.state.tabs.slice(index + 1)
  if (toClose.some((tab) => !canClose(tab))) return
  for (const tab of toClose) closeSession(tab.key)
  tabs.closeRight(key)
}

function onGlobalClick() {
  menu.value = null
}

onMounted(() => window.addEventListener('click', onGlobalClick))
onBeforeUnmount(() => window.removeEventListener('click', onGlobalClick))

const menuIndex = computed(() =>
  menu.value ? tabs.state.tabs.findIndex((t) => t.key === menu.value!.tabKey) : -1,
)
const menuTab = computed(() =>
  menu.value ? tabs.state.tabs.find((t) => t.key === menu.value!.tabKey) ?? null : null,
)
</script>

<template>
  <div class="editor-tabs">
    <div class="tabstrip">
      <div
        v-for="t in tabs.state.tabs"
        :key="t.key"
        class="tab"
        :class="{ active: t.key === tabs.state.activeKey }"
        @click="tabs.activate(t.key)"
        @contextmenu="openMenu($event, t.key)"
      >
        <span class="tab-title" :title="tabs.displayTitle(t)">{{ tabs.displayTitle(t) }}</span>
        <button class="tab-close" title="Close tab" @click.stop="closeTab(t.key)"><X :size="14" /></button>
      </div>
    </div>
    <QueryEditor v-if="active" :tab="active" />
    <div v-else class="editor-empty">
      <p>No open tabs</p>
      <button class="primary" @click="tabs.newQuery()">New query</button>
    </div>

    <div
      v-if="menu"
      class="tab-menu"
      :style="{ left: menu.x + 'px', top: menu.y + 'px' }"
      @click.stop
    >
      <button v-if="menuTab?.source === 'file'" @click="menuItem(() => togglePin(menu!.tabKey))">
        {{ menuTab.pinnedId && tabs.isPinned(menuTab.key) ? 'Unpin' : 'Pin' }}
      </button>
      <button @click="menuItem(() => closeTab(menu!.tabKey))">Close</button>
      <button @click="menuItem(() => closeAllTabs())">Close all</button>
      <button :disabled="tabs.state.tabs.length <= 1" @click="menuItem(() => closeOtherTabs(menu!.tabKey))">
        Close all except this
      </button>
      <button :disabled="menuIndex >= tabs.state.tabs.length - 1" @click="menuItem(() => closeRightTabs(menu!.tabKey))">
        Close all on the right
      </button>
    </div>
  </div>
</template>
