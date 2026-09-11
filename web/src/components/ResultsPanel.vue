<script setup lang="ts">
import { computed, inject, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { Copy, Download, Play, Square } from 'lucide-vue-next'
import { useResults } from '../composables/results'
import { useConnection } from '../composables/connection'
import { useTabs } from '../composables/tabs'
import { useToast } from '../composables/toast'
import { copyGrid, copyText, downloadCsv } from '../lib/gridio'

const results = useResults()
const conn = useConnection()
const tabs = useTabs()
const toast = useToast()
const run = inject<(sql?: string) => void>('pgdev:run')

const result = computed(() => results.state.byTab[tabs.state.activeKey] ?? null)
const activeGrid = computed(() =>
  result.value && !result.value.showMessages ? result.value.grid : null,
)

function showResultView() {
  if (result.value) result.value.showMessages = false
}

function showMessagesView() {
  if (result.value) result.value.showMessages = true
}

const ROW_H = 24
const HEADER_H = 24
const COL_W = 180
const bodyEl = ref<HTMLElement | null>(null)
const scrollTop = ref(0)
const bodyH = ref(300)
let observer: ResizeObserver | null = null

const widthsByKey = reactive(new Map<string, number[]>())
let dragCol = -1
let dragStartX = 0
let dragStartW = 0

function colWidth(i: number): number {
  const key = activeGrid.value?.key ?? ''
  return widthsByKey.get(key)?.[i] ?? COL_W
}

function ensureWidths(key: string, count: number) {
  let arr = widthsByKey.get(key)
  if (!arr || arr.length !== count) {
    arr = Array.from({ length: count }, () => COL_W)
    widthsByKey.set(key, arr)
  }
}

const innerWidth = computed(() => {
  const g = activeGrid.value
  if (!g) return 0
  return g.columns.reduce((sum, _c, i) => sum + colWidth(i), 0)
})

function startResize(i: number, e: MouseEvent) {
  e.preventDefault()
  e.stopPropagation()
  dragCol = i
  dragStartX = e.clientX
  dragStartW = colWidth(i)
  window.addEventListener('mousemove', onResizeMove)
  window.addEventListener('mouseup', endResize)
}

function onResizeMove(e: MouseEvent) {
  if (dragCol < 0) return
  const arr = widthsByKey.get(activeGrid.value?.key ?? '')
  if (arr) arr[dragCol] = Math.max(60, Math.min(1200, dragStartW + e.clientX - dragStartX))
}

function endResize() {
  dragCol = -1
  window.removeEventListener('mousemove', onResizeMove)
  window.removeEventListener('mouseup', endResize)
}

watch(bodyEl, (el) => {
  observer?.disconnect()
  observer = null
  if (el) {
    bodyH.value = el.clientHeight
    observer = new ResizeObserver((entries) => {
      bodyH.value = entries[0]?.contentRect.height ?? 300
    })
    observer.observe(el)
  }
})

watch(
  () => activeGrid.value,
  (g) => {
    scrollTop.value = 0
    if (bodyEl.value) bodyEl.value.scrollTop = 0
    if (g) ensureWidths(g.key, g.columns.length)
  },
)

watch(
  () => tabs.state.tabs.map((t) => t.key),
  (keys) => {
    const set = new Set(keys)
    for (const key of Object.keys(results.state.byTab)) {
      if (!set.has(key)) results.drop(key)
    }
  },
)

onBeforeUnmount(() => observer?.disconnect())

const grid = computed(() => {
  const g = activeGrid.value
  if (!g) return null
  const start = Math.max(0, Math.floor(scrollTop.value / ROW_H) - 5)
  const visible = Math.ceil(bodyH.value / ROW_H) + 10
  return { g, start, rows: g.rows.slice(start, start + visible) }
})

function onScroll() {
  if (bodyEl.value) scrollTop.value = bodyEl.value.scrollTop
}

function fmt(v: unknown): string {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

async function copyCell(v: unknown) {
  const text = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)
  const ok = await copyText(text)
  toast.show(ok ? 'Value copied' : 'Copy to clipboard failed')
}

function cancelRun() {
  if (!conn.state.id || !result.value?.running) return
  results.cancel(tabs.state.activeKey, conn.state.id)
  toast.show('Canceling query…')
}

async function copyResult() {
  const g = activeGrid.value
  if (!g) return
  const ok = await copyGrid(g.columns, g.rows)
  toast.show(ok ? `Copied ${g.rows.length} row(s) to clipboard` : 'Copy to clipboard failed')
}

function exportCsv() {
  const g = activeGrid.value
  if (!g) return
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)
  downloadCsv(g.columns, g.rows, `pgdev-result-${stamp}.csv`)
  toast.show(`Exported ${g.rows.length} row(s) to CSV`)
}
</script>

<template>
  <div class="results">
    <div class="results-head">
      <div class="subtabs">
        <button
          class="subtab"
          :class="{ active: !!result && !result.showMessages }"
          :disabled="!result?.grid"
          @click="showResultView()"
        >
          Result
        </button>
        <button
          class="subtab"
          :class="{ active: !result || result.showMessages }"
          @click="showMessagesView()"
        >
          Messages
        </button>
      </div>
      <span class="spacer" />
      <template v-if="activeGrid">
        <button class="btn-sm" title="Copy result to clipboard (TSV)" @click="copyResult()"><Copy :size="13" /> COPY</button>
        <button class="btn-sm" title="Export result to CSV" @click="exportCsv()"><Download :size="13" /> CSV</button>
      </template>
      <button
        v-if="result?.running"
        class="danger"
        title="Cancel running query"
        @click="cancelRun()"
      >
        <Square :size="11" /> Cancel
      </button>
      <button
        v-else
        class="primary run-btn"
        :disabled="!conn.state.id"
        title="Ctrl+Enter"
        @click="run?.()"
      >
        <Play :size="13" /> Run
      </button>
    </div>

    <div v-if="!result || result.showMessages || !result.grid" class="messages">
      <div v-if="!result || !result.messages.length" class="msg dim">
        Run a query to see results (Ctrl+Enter in the editor).
      </div>
      <div v-for="(m, i) in result?.messages ?? []" :key="i" class="msg" :class="m.level">
        {{ m.text }}
      </div>
    </div>

    <div v-else-if="grid" class="grid">
      <div ref="bodyEl" class="grid-body" @scroll="onScroll">
        <div class="grid-inner" :style="{ width: innerWidth + 'px' }">
          <div class="grid-head">
            <div
              v-for="(c, i) in grid.g.columns"
              :key="i"
              class="grid-cell head"
              :style="{ width: colWidth(i) + 'px' }"
            >
              <span class="col-name">{{ c }}</span><span v-if="grid.g.columnTypes[i]" class="col-type"> ({{ grid.g.columnTypes[i] }})</span>
              <span class="col-resize-handle" title="Resize column" @mousedown="startResize(i, $event)" @click.stop />
            </div>
          </div>
          <div class="grid-spacer" :style="{ height: HEADER_H + grid.g.rows.length * ROW_H + 'px' }" />
          <div
            v-for="(r, i) in grid.rows"
            :key="i"
            class="grid-row"
            :style="{ top: HEADER_H + (grid.start + i) * ROW_H + 'px' }"
          >
            <div
              v-for="(cell, j) in r"
              :key="j"
              class="grid-cell"
              :class="{ nul: cell === null || cell === undefined }"
              :style="{ width: colWidth(j) + 'px' }"
              title="Double-click to copy"
              @dblclick="copyCell(cell)"
            >
              {{ fmt(cell) }}
            </div>
          </div>
        </div>
      </div>
      <div class="grid-foot">
        {{ grid.g.rowCount }} row(s)
        <span v-if="grid.g.truncated">· truncated</span>
      </div>
    </div>
  </div>
</template>
