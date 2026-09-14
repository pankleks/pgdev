<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { Copy, X } from 'lucide-vue-next'
import { useToast } from '../composables/toast'
import { copyText } from '../lib/gridio'
import { formatCellValue } from '../lib/cellvalue'

// Value dialog: opened by double-clicking a results-grid cell. Shows the raw
// cell value (pretty-printed for JSON/JSONB) with a copy button — replacing
// the old double-click-to-copy, which is now the only copy path for a cell.

export interface CellValueTarget {
  column: string
  type: string
  value: string
}

const props = defineProps<{ target: CellValueTarget }>()
const emit = defineEmits<{ close: [] }>()

const toast = useToast()

const text = computed(() => formatCellValue(props.target.value, props.target.type))
const copying = ref(false)

/** Copy the displayed text; success closes the dialog, failure keeps it open. */
async function copy() {
  if (copying.value) return
  copying.value = true
  try {
    const ok = await copyText(text.value)
    toast.show(ok ? 'Value copied.' : 'Copy to clipboard failed')
    if (ok) emit('close')
  } finally {
    copying.value = false
  }
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.stopPropagation()
    emit('close')
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <div class="modal-backdrop" @mousedown.self="emit('close')">
    <div class="modal valuedialog-modal">
      <button class="icon valuedialog-close" title="Close" @click="emit('close')"><X :size="16" /></button>

      <h2>
        <span class="valuedialog-column">{{ target.column }}</span>
        <span v-if="target.type" class="valuedialog-type">({{ target.type }})</span>
      </h2>

      <!-- pre, not a textarea: the value is read-only presentation, whitespace
           and long lines are preserved exactly, and the Copy button is the
           deliberate copy path. -->
      <pre class="valuedialog-text">{{ text }}</pre>

      <div class="valuedialog-foot">
        <span class="valuedialog-length">{{ text.length.toLocaleString() }} character(s)</span>
        <span class="valuedialog-actions">
          <button class="primary" :disabled="copying" @click="copy"><Copy :size="14" /> COPY</button>
        </span>
      </div>
    </div>
  </div>
</template>
