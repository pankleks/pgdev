<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { Save, X } from 'lucide-vue-next'
import { useToast } from '../composables/toast'
import { api } from '../api'
import { formatCellForDisplay } from '../lib/gridio'
import {
  editorKind,
  fromEditorValue,
  isReadOnlyType,
  jsonSyntaxError,
  numberStep,
  toBool,
  toEditorValue,
  usesTextarea,
  type EditorKind,
} from '../lib/celleditor'
import type { DataResult } from '../types'

// Row editor: one dialog per row, one UPDATE on SAVE. The grid's `editable`
// metadata (plain single-table SELECT with the full primary key present)
// decides which columns are writable; primary keys, generated columns and
// non-column expressions stay visible but locked. Every value control matches
// the column type, with a NULL checkbox beside it (for booleans: a value
// checkbox plus the NULL checkbox).

export interface RowEditTarget {
  grid: DataResult
  /** The row's cells, captured from the loaded page. */
  row: unknown[]
  connectionId: string
  tabKey: string
  /** True when the tab has an open manual transaction the save will join. */
  inTransaction: boolean
}

interface Field {
  index: number
  name: string
  type: string
  kind: EditorKind
  /** Read-only reason shown as a tag, or null when the field is editable. */
  tag: string | null
  editable: boolean
  /** False for NOT NULL columns — no NULL checkbox is offered. */
  nullable: boolean
  /** Declared character length (varchar(n)/char(n)) for the text control. */
  maxLength: number | null
  original: unknown
  wasNull: boolean
  /** Current NULL checkbox state. */
  null: boolean
  /** Current control text (all kinds except boolean). */
  text: string
  initialText: string
  /** Current boolean value checkbox state. */
  bool: boolean
  initialBool: boolean
}

const props = defineProps<{ target: RowEditTarget }>()
const emit = defineEmits<{ close: []; saved: [row: Record<string, unknown>] }>()
const toast = useToast()

function buildFields(target: RowEditTarget): Field[] {
  const { grid, row } = target
  const editable = grid.editable
  const meta = new Map((editable?.columns ?? []).map((c) => [c.name, c]))
  const counts = new Map<string, number>()
  for (const name of grid.columns) counts.set(name, (counts.get(name) ?? 0) + 1)

  return grid.columns.map((name, index) => {
    const type = grid.columnTypes[index] ?? ''
    // The server already filtered to columns present exactly once; the count
    // re-check keeps a mismatched payload read-only rather than wrong.
    const info = counts.get(name) === 1 ? meta.get(name) : undefined
    const original = row[index] ?? null
    const wasNull = original === null || original === undefined
    const kind = editorKind(type)
    let tag: string | null = null
    if (!info) tag = 'not a plain column'
    else if (info.pk) tag = 'primary key'
    else if (info.generated) tag = 'generated'
    else if (isReadOnlyType(type)) tag = 'binary'
    const initialText = wasNull ? '' : toEditorValue(String(original), type)
    return {
      index,
      name,
      type,
      kind,
      tag,
      editable: info !== undefined && !info.pk && !info.generated && !isReadOnlyType(type),
      nullable: info?.nullable === true,
      maxLength: grid.columnTypeLengths?.[index] ?? null,
      original,
      wasNull,
      null: wasNull,
      text: initialText,
      initialText,
      bool: toBool(original),
      initialBool: toBool(original),
    }
  })
}

const fields = reactive<Field[]>(orderFields(buildFields(props.target)))

/** Underscore-prefixed (system-ish) columns render after the ordinary ones,
 * in their original result order within each group — the same display
 * convention as the table editor. Field `index` still points at the result
 * column, so only the visual order changes. */
function orderFields(list: Field[]): Field[] {
  const meta = (f: Field) => f.name.startsWith('_')
  return [...list.filter((f) => !meta(f)), ...list.filter(meta)]
}

const saving = ref(false)
const error = ref<string | null>(null)

function isDirty(f: Field): boolean {
  if (!f.editable) return false
  if (f.null !== f.wasNull) return true
  if (f.null) return false
  if (f.kind === 'boolean') return f.bool !== f.initialBool
  return f.text !== f.initialText
}

/** `<input type="number">` with plain v-model hands Vue a number, which would
 * never equal the original text (`1.50` → `1.5`) and keep the row dirty; the
 * value stays a string here and PostgreSQL casts it. */
function onNumberInput(f: Field, e: Event) {
  f.text = (e.target as HTMLInputElement).value
}

const dirty = computed(() => fields.filter(isDirty))
const changeCount = computed(() => dirty.value.length)
const keyFields = computed(() => fields.filter((f) => f.tag === 'primary key'))
const tableLabel = computed(() => {
  const editable = props.target.grid.editable
  return editable ? `${editable.schema}.${editable.table}` : ''
})

async function save() {
  const editable = props.target.grid.editable
  if (saving.value || !editable || !changeCount.value) return
  // Changed JSON is syntax-checked here, before any request: a malformed
  // textarea would otherwise come back as a cast error from PostgreSQL.
  for (const f of dirty.value) {
    if (f.kind !== 'json' || f.null) continue
    const problem = jsonSyntaxError(f.text)
    if (problem) {
      error.value = `Invalid JSON in "${f.name}": ${problem}`
      return
    }
  }
  const key: Record<string, unknown> = {}
  for (const f of keyFields.value) key[f.name] = f.original
  const set: Record<string, unknown | null> = {}
  for (const f of dirty.value) {
    set[f.name] = f.null ? null : f.kind === 'boolean' ? f.bool : fromEditorValue(f.text)
  }

  saving.value = true
  error.value = null
  try {
    const res = await api.updateRow(props.target.connectionId, {
      tabKey: props.target.tabKey,
      schema: editable.schema,
      table: editable.table,
      key,
      set,
    })
    toast.show(res.transactionOpen ? 'Row updated in the open transaction.' : 'Row updated.')
    emit('saved', res.row)
    emit('close')
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    saving.value = false
  }
}

function close() {
  if (saving.value) return
  const count = changeCount.value
  if (count && !window.confirm(`Discard ${count} unsaved change(s)?`)) return
  emit('close')
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.stopPropagation()
    close()
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
  <div class="modal-backdrop" @mousedown.self="close">
    <div class="modal rowedit-modal">
      <button class="icon rowedit-close" title="Close" @click="close"><X :size="16" /></button>

      <h2>
        <span class="rowedit-title">Edit row</span>
        <span v-if="tableLabel" class="rowedit-table">{{ tableLabel }}</span>
        <span v-if="target.inTransaction" class="txn-badge" title="SAVE joins the open transaction">TXN</span>
      </h2>

      <div class="rowedit-fields">
        <table class="rowedit-grid">
          <thead>
            <tr>
              <th>Column</th>
              <th>Value</th>
              <th class="rowedit-col-null">NULL</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="f in fields" :key="f.index" class="rowedit-field">
              <td class="rowedit-label">
                <div class="rowedit-name">{{ f.name }}</div>
                <div class="rowedit-meta">
                  <span class="rowedit-type">{{ f.type }}</span>
                  <span v-if="f.tag" class="rowedit-tag">{{ f.tag }}</span>
                </div>
              </td>

              <td class="rowedit-control">
                <template v-if="!f.editable">
                  <span class="rowedit-locked" :class="{ nul: f.wasNull }">
                    <span v-if="f.wasNull" class="null-badge">null</span>
                    <template v-else>{{ formatCellForDisplay(f.original) }}</template>
                  </span>
                </template>

                <template v-else-if="f.kind === 'boolean'">
                  <input v-model="f.bool" type="checkbox" :disabled="f.null" />
                </template>

                <template v-else-if="f.kind === 'number'">
                  <input
                    :value="f.text"
                    class="rowedit-input"
                    type="number"
                    :step="numberStep(f.type)"
                    :disabled="f.null"
                    @input="onNumberInput(f, $event)"
                  />
                </template>

                <template v-else-if="f.kind === 'date' || f.kind === 'time' || f.kind === 'datetime'">
                  <input
                    v-model="f.text"
                    class="rowedit-input"
                    :type="f.kind === 'datetime' ? 'datetime-local' : f.kind"
                    step="any"
                    :disabled="f.null"
                  />
                </template>

                <template v-else-if="usesTextarea(f.type)">
                  <textarea
                    v-model="f.text"
                    class="rowedit-textarea"
                    :class="{ json: f.kind === 'json' }"
                    spellcheck="false"
                    :maxlength="f.maxLength ?? undefined"
                    :disabled="f.null"
                  />
                </template>

                <template v-else>
                  <input
                    v-model="f.text"
                    class="rowedit-input"
                    type="text"
                    spellcheck="false"
                    :maxlength="f.maxLength ?? undefined"
                    :disabled="f.null"
                  />
                </template>
              </td>

              <td v-if="f.editable && f.nullable" class="rowedit-null">
                <input
                  v-model="f.null"
                  type="checkbox"
                  :title="`Set ${f.name} to NULL`"
                  :aria-label="`Set ${f.name} to NULL`"
                />
              </td>
              <td v-else class="rowedit-null-empty" />
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="error" class="rowedit-error">{{ error }}</div>

      <div class="rowedit-foot">
        <span class="rowedit-count">
          {{ changeCount ? `${changeCount} change(s)` : 'No changes' }}
        </span>
        <span class="rowedit-actions">
          <button :disabled="saving" @click="close">CANCEL</button>
          <button class="primary" :disabled="saving || !changeCount" @click="save">
            <Save :size="14" /> {{ saving ? 'SAVING…' : 'SAVE' }}
          </button>
        </span>
      </div>
    </div>
  </div>
</template>
