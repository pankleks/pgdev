<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { X } from 'lucide-vue-next'
import { useTabs } from '../composables/tabs'
import QueryEditor from './QueryEditor.vue'

const tabs = useTabs()
const active = computed(
  () => tabs.state.tabs.find((t) => t.key === tabs.state.activeKey) ?? null,
)

const menu = ref<{ x: number; y: number; tabKey: string } | null>(null)

function openMenu(e: MouseEvent, tabKey: string) {
  e.preventDefault()
  const w = 190
  const h = 120
  menu.value = {
    x: Math.min(e.clientX, window.innerWidth - w - 8),
    y: Math.min(e.clientY, window.innerHeight - h - 8),
    tabKey,
  }
}

function menuItem(action: () => void) {
  action()
  menu.value = null
}

function onGlobalClick() {
  menu.value = null
}

onMounted(() => window.addEventListener('click', onGlobalClick))
onBeforeUnmount(() => window.removeEventListener('click', onGlobalClick))

const menuIndex = computed(() =>
  menu.value ? tabs.state.tabs.findIndex((t) => t.key === menu.value!.tabKey) : -1,
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
        <span class="tab-title">{{ t.title }}</span>
        <button class="tab-close" title="Close tab" @click.stop="tabs.close(t.key)"><X :size="14" /></button>
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
      <button @click="menuItem(() => tabs.close(menu!.tabKey))">Close</button>
      <button @click="menuItem(() => tabs.closeAll())">Close all</button>
      <button :disabled="tabs.state.tabs.length <= 1" @click="menuItem(() => tabs.closeOthers(menu!.tabKey))">
        Close all except this
      </button>
      <button :disabled="menuIndex >= tabs.state.tabs.length - 1" @click="menuItem(() => tabs.closeRight(menu!.tabKey))">
        Close all on the right
      </button>
    </div>
  </div>
</template>
