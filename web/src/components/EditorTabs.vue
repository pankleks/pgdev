<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { ListX, PanelRightClose, PanelTopClose, Pin, PinOff, X } from 'lucide-vue-next'
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

// --- drag-and-drop reordering ---------------------------------------------
const dragKey = ref<string | null>(null)
/** Insertion position 0..length in the current order (null when not dragging). */
const dropIndex = ref<number | null>(null)
// Set on dragstart and cleared on the next mousedown: some browsers fire a
// click after a drag, which must not re-activate the dragged tab.
const suppressClick = ref(false)

function onTabClick(key: string) {
  if (suppressClick.value) return
  tabs.activate(key)
}

function onDragStart(e: DragEvent, key: string) {
  dragKey.value = key
  dropIndex.value = null
  suppressClick.value = true
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    // Firefox needs data set on the transfer for a drag to begin at all.
    e.dataTransfer.setData('text/plain', key)
  }
}

function onDragOverTab(e: DragEvent, index: number) {
  if (dragKey.value === null) return
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  dropIndex.value = e.clientX < rect.left + rect.width / 2 ? index : index + 1
}

function onDragOverStrip(e: DragEvent) {
  if (dragKey.value === null) return
  e.preventDefault()
  dropIndex.value = tabs.state.tabs.length
}

function onDrop(e: DragEvent) {
  e.preventDefault()
  if (dragKey.value !== null && dropIndex.value !== null) {
    tabs.moveTabToIndex(dragKey.value, dropIndex.value)
  }
  onDragEnd()
}

function onDragEnd() {
  dragKey.value = null
  dropIndex.value = null
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
// DDL generated on a connection that is no longer the active one.
const staleDdl = computed(() => {
  const tab = active.value
  return !!tab?.connectionId && !!conn.state.id && tab.connectionId !== conn.state.id
})
</script>

<template>
  <div class="editor-tabs">
    <div class="tabstrip" @dragover.self="onDragOverStrip($event)" @drop="onDrop($event)">
      <div
        v-for="(t, index) in tabs.state.tabs"
        :key="t.key"
        class="tab"
        :class="{
          active: t.key === tabs.state.activeKey,
          dragging: dragKey === t.key,
          'drop-before': dropIndex === index,
          'drop-after': dropIndex === index + 1,
        }"
        draggable="true"
        @mousedown="suppressClick = false"
        @click="onTabClick(t.key)"
        @contextmenu="openMenu($event, t.key)"
        @dragstart="onDragStart($event, t.key)"
        @dragover="onDragOverTab($event, index)"
        @dragend="onDragEnd"
      >
        <span class="tab-title" :title="tabs.displayTitle(t)">{{ tabs.displayTitle(t) }}</span>
        <button class="tab-close" title="Close tab" draggable="false" @click.stop="closeTab(t.key)"><X :size="14" /></button>
      </div>
    </div>
    <div v-if="staleDdl" class="stale-ddl">
      This DDL was generated from a different database connection. Re-open the object to
      refresh it; running it here is disabled.
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
        <PinOff v-if="menuTab.pinnedId && tabs.isPinned(menuTab.key)" :size="14" />
        <Pin v-else :size="14" />
        {{ menuTab.pinnedId && tabs.isPinned(menuTab.key) ? 'Unpin' : 'Pin' }}
      </button>
      <button @click="menuItem(() => closeAllTabs())"><ListX :size="14" /> Close all</button>
      <button :disabled="tabs.state.tabs.length <= 1" @click="menuItem(() => closeOtherTabs(menu!.tabKey))">
        <PanelTopClose :size="14" />
        Close all except this
      </button>
      <button :disabled="menuIndex >= tabs.state.tabs.length - 1" @click="menuItem(() => closeRightTabs(menu!.tabKey))">
        <PanelRightClose :size="14" />
        Close all on the right
      </button>
    </div>
  </div>
</template>
