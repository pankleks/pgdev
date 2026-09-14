<script setup lang="ts">
import { computed, inject, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { Copy, Download, Play, Square } from 'lucide-vue-next'
import { useResults } from '../composables/results'
import { useConnection } from '../composables/connection'
import { useTabs } from '../composables/tabs'
import { useToast } from '../composables/toast'
import { copyGrid, copyText, downloadCsv, csvHeader, csvRows, formatCellForDisplay } from '../lib/gridio'
import ValueDialog, { type CellValueTarget } from './ValueDialog.vue'

const results = useResults()
const conn = useConnection()
const tabs = useTabs()
const toast = useToast()
const run = inject<(sql?: string) => void>('pgdev:run')

const result = computed(() => results.state.byTab[tabs.state.activeKey] ?? null)
const activeGrid = computed(() =>
  result.value && !result.value.showMessages ? result.value.grid : null,
)

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
const columnsByKey = reactive(new Map<string, string[]>())
let dragCol = -1
let dragStartX = 0
let dragStartW = 0

function colWidth(i: number): number {
  const key = activeGrid.value?.key ?? ''
  return widthsByKey.get(key)?.[i] ?? COL_W
}

function ensureWidths(key: string, columns: string[]) {
  const arr = widthsByKey.get(key)
  const prev = columnsByKey.get(key)
  const same =
    arr &&
    prev &&
    arr.length === columns.length &&
    prev.length === columns.length &&
    prev.every((c, i) => c === columns[i])
  if (!same) {
    widthsByKey.set(
      key,
      Array.from({ length: columns.length }, () => COL_W),
    )
    columnsByKey.set(key, [...columns])
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
    endResize()
    scrollTop.value = 0
    if (bodyEl.value) bodyEl.value.scrollTop = 0
    if (g) ensureWidths(g.key, g.columns)
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

watch(
  () => Object.values(results.state.byTab).flatMap((r) => r.grids.map((g) => g.key)),
  (keys) => {
    const live = new Set(keys)
    for (const key of widthsByKey.keys()) {
      if (!live.has(key)) {
        widthsByKey.delete(key)
        columnsByKey.delete(key)
      }
    }
  },
)

onBeforeUnmount(() => { observer?.disconnect(); endResize() })

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
  return formatCellForDisplay(v)
}

/** Double-click behaviour: JSON/JSONB cells open the value dialog (pretty
 * printed, with its own COPY), everything else copies straight to the
 * clipboard like it used to. NULL stays inert — the badge says it all. */
const cellValue = ref<CellValueTarget | null>(null)

function isJsonColumn(j: number): boolean {
  const type = activeGrid.value?.columnTypes[j]
  return type === 'json' || type === 'jsonb'
}

function openCell(v: unknown, j: number) {
  if (v === null || v === undefined) return
  const g = activeGrid.value
  if (!g) return
  if (g.columnTypes[j] === 'json' || g.columnTypes[j] === 'jsonb') {
    cellValue.value = {
      column: g.columns[j] ?? '',
      type: g.columnTypes[j],
      value: typeof v === 'string' ? v : String(v),
    }
    return
  }
  void copyCell(v)
}

async function copyCell(v: unknown) {
  const ok = await copyText(typeof v === 'string' ? v : String(v))
  toast.show(ok ? 'Value copied.' : 'Copy to clipboard failed')
}

function cancelRun() {
  if (!conn.state.id || (!result.value?.running && !result.value?.loadingMore)) return
  results.cancel(tabs.state.activeKey, conn.state.id)
  toast.show(result.value.loadingMore ? 'Canceling row load…' : 'Canceling query…')
}

function loadMoreRows() {
  if (!conn.state.id || !result.value?.grid?.truncated) return
  results.loadMore(tabs.state.activeKey, conn.state.id)
}

/** Commit/Rollback run through the normal run path for the active tab, so the
 * per-tab running guard, messages and session release all apply. */
function runControl(sql: 'COMMIT' | 'ROLLBACK') {
  if (!conn.state.id || result.value?.running || result.value?.loadingMore) return
  results.run(tabs.state.activeKey, conn.state.id, sql)
}

async function copyResult() {
  const g = activeGrid.value
  if (!g) return
  const ok = await copyGrid(g.columns, g.rows)
  toast.show(ok ? `Copied ${g.rows.length} row(s) to clipboard` : 'Copy to clipboard failed')
}

/** Minimal shape of the File System Access save picker (Chrome/Edge). */
interface SavePicker {
  showSaveFilePicker?: (options?: { suggestedName?: string }) => Promise<{
    createWritable(): {
      write(data: string): Promise<void>
      close(): Promise<void>
      abort(): Promise<void>
    }
  }>
}

async function exportCsv() {
  const connectionId = conn.state.id
  if (!connectionId) return
  const tabKey = tabs.state.activeKey
  // The grid is captured here, before any await: the save picker and the
  // drain run later, and a selection change meanwhile must not switch what
  // gets exported (the store re-validates this capture every step).
  const g = results.state.byTab[tabKey]?.grid
  if (!g) return
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)
  const filename = `pgDEV-statement-${g.statementNumber}-${stamp}${g.limited ? '-partial' : ''}.csv`

  // Stream pages straight to disk when the browser can: memory stays flat
  // (drained pages are not retained in the grid) and every write is awaited
  // so a failed write aborts the file instead of vanishing into a void.
  const picker = (window as unknown as SavePicker).showSaveFilePicker
  if (picker) {
    let handle
    try {
      handle = await picker.call(window, { suggestedName: filename })
    } catch (e) {
      if ((e as Error).name !== 'AbortError') toast.show(`Export failed: ${(e as Error).message}`)
      return
    }
    let writable
    try {
      writable = await handle.createWritable()
    } catch (e) {
      toast.show(`Export failed: ${(e as Error).message}`)
      return
    }
    let rows = 0
    try {
      await writable.write(csvHeader(g.columns))
      const complete = await results.exportAll(tabKey, connectionId, g, async (page) => {
        rows += page.length
        await writable.write(csvRows(page))
      }, false)
      if (!complete) {
        // Stale drain (connection/tab/result changed): discard the partial
        // file rather than leaving truncated data on disk.
        await writable.abort()
        toast.show('Export canceled because the connection or result changed')
        return
      }
      await writable.close()
      toast.show(g.limited
        ? `Exported first ${rows} of ${g.totalRowCount} rows to CSV (partial result)`
        : `Exported ${rows} row(s) to CSV`)
    } catch (e) {
      await writable.abort().catch(() => undefined)
      toast.show(`Export failed: ${(e as Error).message}`)
    }
    return
  }

  // Fallback: drain into the grid, then download one Blob.
  if (g.truncated) {
    toast.show('Loading all rows for export…')
    const ok = await results.loadAll(tabKey, connectionId, g)
    if (!ok) {
      toast.show('Export failed — see Messages')
      return
    }
    toast.show(`Loaded all rows (${g.rows.length} total), exporting…`)
  }
  downloadCsv(g.columns, g.rows, filename)
  toast.show(g.limited
    ? `Exported first ${g.rows.length} of ${g.totalRowCount} rows to CSV (partial result)`
    : `Exported ${g.rows.length} row(s) to CSV`)
}
</script>

<template>
  <div class="results">
    <div class="results-head">
      <div class="subtabs">
        <button
          v-for="(g, index) in result?.grids ?? []"
          :key="g.key"
          class="subtab"
          :class="{ active: !result?.showMessages && result?.grid?.key === g.key }"
          :aria-pressed="!result?.showMessages && result?.grid?.key === g.key"
          :title="`Statement ${g.statementNumber} · ${g.rows.length} loaded row(s)${g.limited ? ' · partial result' : ''}`"
          @click="results.selectGrid(tabs.state.activeKey, g.key)"
        >
          Result {{ index + 1 }}
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
      <template v-if="result?.transactionOpen">
        <span class="txn-badge" title="A manual transaction is open for this tab">TXN</span>
        <button
          class="btn-sm commit"
          :disabled="result?.running || result?.loadingMore"
          title="Commit the open transaction"
          @click="runControl('COMMIT')"
        >COMMIT</button>
        <button
          class="btn-sm danger"
          :disabled="result?.running || result?.loadingMore"
          title="Roll back the open transaction"
          @click="runControl('ROLLBACK')"
        >ROLLBACK</button>
      </template>
      <template v-if="activeGrid">
        <button class="btn-sm" title="Copy loaded rows to clipboard (TSV)" :disabled="result?.loadingMore" @click="copyResult()"><Copy :size="13" /> COPY</button>
        <button class="btn-sm" :title="activeGrid.limited ? 'Export only the retained rows to CSV (partial result)' : 'Export all rows to CSV'" :disabled="result?.loadingMore" @click="exportCsv()"><Download :size="13" /> {{ activeGrid.limited ? 'CSV (partial)' : 'CSV' }}</button>
      </template>
      <button
        v-if="result?.running || result?.loadingMore"
        class="danger"
        :disabled="result?.cancelling"
        title="Cancel running query or row load"
        @click="cancelRun()"
      >
        <Square :size="11" /> {{ result?.cancelling ? 'Canceling…' : result?.loadingMore ? 'Cancel load' : 'Cancel' }}
      </button>
      <button
        v-else
        class="primary run-btn"
        :disabled="!conn.state.id || result?.loadingMore || tabs.state.tabs.find((t) => t.key === tabs.state.activeKey)?.readOnly"
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
              :key="`${i}-${c}`"
              class="grid-cell head"
              :style="{ width: colWidth(i) + 'px' }"
            >
              <span class="col-name">{{ c }}</span><span v-if="grid.g.columnTypes[i]" class="col-type"> ({{ grid.g.columnTypes[i] }})</span>
              <span class="col-resize-handle" title="Resize column" @mousedown="startResize(i, $event)" @click.stop />
            </div>
          </div>
          <div class="grid-spacer" :style="{ height: grid.g.rows.length * ROW_H + 'px' }" />
          <div
            v-for="(r, i) in grid.rows"
            :key="grid.start + i"
            class="grid-row"
            :style="{ top: HEADER_H + (grid.start + i) * ROW_H + 'px' }"
          >
            <div
              v-for="(cell, j) in r"
              :key="j"
              class="grid-cell"
              :class="{ nul: cell === null || cell === undefined }"
              :style="{ width: colWidth(j) + 'px' }"
              :title="isJsonColumn(j) ? 'Double-click to open value' : 'Double-click to copy'"
              @dblclick="openCell(cell, j)"
            >
              <span v-if="cell === null || cell === undefined" class="null-badge">null</span>
              <span
                v-else-if="grid.g.columnTypes[j] === 'boolean'"
                class="bool-badge"
                :class="cell === true || cell === 'true' ? 'true' : 'false'"
              >{{ cell === true || cell === 'true' ? 'true' : 'false' }}</span>
              <template v-else>{{ fmt(cell) }}</template>
            </div>
          </div>
        </div>
      </div>
      <div class="grid-foot">
        <!-- the result's own rowCount, not the virtualised slice actually
             rendered: grid.rows is only the visible window -->
        {{ result?.grid?.rowCount ?? 0 }} row(s)
        <span v-if="grid.g.truncated">· more available</span>
        <span v-else-if="grid.g.limited">· first {{ grid.g.rows.length }} of {{ grid.g.totalRowCount }} · row limit reached; remaining rows were not retained</span>
        <span v-else-if="grid.g.exported">· first {{ grid.g.rows.length }} shown · {{ grid.g.exported.rows }} row(s) exported to CSV</span>
        <button
          v-if="grid.g.truncated"
          class="btn-sm"
          :disabled="result?.loadingMore"
          title="Fetch the next page of rows"
          @click="loadMoreRows()"
        >
          {{ result?.loadingMore ? 'Loading…' : 'Load more' }}
        </button>
      </div>
    </div>

    <ValueDialog v-if="cellValue" :target="cellValue" @close="cellValue = null" />
  </div>
</template>
