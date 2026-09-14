<script setup lang="ts">
import { onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { KeyRound, Lock, Plus, RotateCcw, Table2, Trash2, X } from 'lucide-vue-next'
import { useConnection } from '../composables/connection'
import { useTabs } from '../composables/tabs'
import { useToast } from '../composables/toast'
import { api } from '../api'
import type { TableEditColumnState, TableEditKeyRef, TableEditState } from '../types'
import { buildColumnType, parseColumnType, SIZE_BASES } from '../lib/tabletype'

// Table editor dialog: loads the live table state for one oid, lets the user
// edit the description and the column list, and on OK asks the server to diff
// it against the catalog again. The generated change-only script opens in a
// new query tab — nothing is executed from here.

export interface TableEditTarget {
  oid: string
  schema: string
  name: string
}

interface EditRow {
  id: string
  name: string
  /** Catalog name at load time — only a placeholder hint for existing rows. */
  catalogName: string
  type: string
  /** Drop-down selection: the base type, parsed from `type` on load. */
  base: string
  /** Length for varchar/char, precision for numeric. */
  len: string
  /** Scale for numeric (the second parenthesized number). */
  scale: string
  nullable: boolean
  defaultValue: string
  description: string
  pk: boolean
  /** Read-only FK badges: "FK1", "FK2", … with name + definition for the tooltip. */
  fks: TableEditKeyRef[]
  /** Read-only UK badges: "UK1", "UK2", … with name + definition for the tooltip. */
  uks: TableEditKeyRef[]
  locked: boolean
  lockKind: TableEditColumnState['lockKind']
  added: boolean
  deleted: boolean
}

const props = defineProps<{ target: TableEditTarget }>()
const emit = defineEmits<{ close: [] }>()

const conn = useConnection()
const tabs = useTabs()
const toast = useToast()

// The connection is captured once: a switch while the dialog is open closes it
// rather than letting a stale dialog edit against the wrong database.
const connectionId = conn.state.id
if (!connectionId) emit('close')

const loading = ref(true)
const loadError = ref('')
const table = ref<TableEditState | null>(null)
const tableDescription = ref('')
/** Live-state hash from the load response; sent back so a table changed in the
 * meantime is rejected server-side instead of diffed against stale columns. */
const fingerprint = ref('')
const rows = reactive<EditRow[]>([])
const submitting = ref(false)
const submitError = ref('')
let newCounter = 0

function rowOf(state: TableEditColumnState): EditRow {
  const parsed = parseColumnType(state.type)
  return {
    id: state.id,
    name: state.name,
    catalogName: state.name,
    type: state.type,
    base: parsed.base,
    len: parsed.len,
    scale: parsed.scale,
    nullable: state.nullable,
    defaultValue: state.defaultValue ?? '',
    description: state.description ?? '',
    pk: state.pk,
    fks: state.fks ?? [],
    uks: state.uks ?? [],
    locked: state.locked,
    lockKind: state.lockKind,
    added: false,
    deleted: false,
  }
}

function addRow() {
  rows.push({
    id: `new:${++newCounter}`,
    name: '',
    catalogName: '',
    type: '',
    base: '',
    len: '',
    scale: '',
    nullable: true,
    defaultValue: '',
    description: '',
    pk: false,
    fks: [],
    uks: [],
    locked: false,
    lockKind: undefined,
    added: true,
    deleted: false,
  })
}

function toggleDelete(row: EditRow) {
  if (row.pk) return
  row.deleted = !row.deleted
}

/** Added rows never reached the catalog, so removing one just drops the row. */
function removeRow(row: EditRow) {
  const index = rows.indexOf(row)
  if (index !== -1) rows.splice(index, 1)
}

// Existing pk columns cannot be dropped or made nullable, and the checkbox
// would only generate a failing ALTER, so it is disabled there. Identity and
// generated columns lock everything except description; serial keeps nullable
// editable since it is independent of the sequence machinery.
function nullableDisabled(row: EditRow): boolean {
  if (row.pk) return true
  return row.locked && row.lockKind !== 'serial'
}

const lockLabel: Record<string, string> = {
  identity: 'identity column',
  generated: 'generated column',
  serial: 'serial column',
}

const TYPE_SUGGESTIONS = [
  'boolean', 'smallint', 'integer', 'bigint', 'numeric', 'real', 'double precision',
  'money', 'text', 'varchar', 'char', 'date', 'time', 'timestamp', 'timestamptz',
  'interval', 'uuid', 'json', 'jsonb', 'bytea', 'inet', 'cidr', 'xml',
  'serial', 'bigserial', 'smallserial',
]

/**
 * Rebuild the authoritative `type` string from base + length + scale. Only
 * called on user interaction — an untouched row keeps the catalog's exact
 * original spelling, so the server diff never sees a phantom type change.
 */
function rebuildType(row: EditRow): void {
  row.type = buildColumnType(row.base, row.len, row.scale)
}

function lenDisabled(row: EditRow): boolean {
  return !SIZE_BASES.has(row.base) || row.locked || row.deleted
}

function scaleDisabled(row: EditRow): boolean {
  return row.base !== 'numeric' || row.locked || row.deleted
}

/** One line per key so the browser tooltip keeps the line breaks. */
function fkTooltip(row: EditRow): string {
  return row.fks.map((f) => `${f.name}: ${f.definition}`).join('\n')
}

function ukTooltip(row: EditRow): string {
  return row.uks.map((u) => `${u.name}: ${u.definition}`).join('\n')
}

/**
 * Color index for a key badge: every number gets its own color and the same
 * number always gets the same one (FK3 and UK3 match), so a multi-column key
 * is visually traceable across rows. More keys than colors cycle the palette.
 */
const KEY_COLORS = 8
function chipIndex(label: string): number {
  const n = Number.parseInt(label.replace(/\D/g, ''), 10) || 0
  return ((n - 1) % KEY_COLORS) + 1
}

/**
 * Predefined base types for the drop-down, plus the column's own type verbatim
 * when it is not one of them (e.g. `timestamp without time zone` or a custom
 * type), so an unedited select can never silently change the existing type.
 */
function typeChoices(row: EditRow): string[] {
  if (row.base && !TYPE_SUGGESTIONS.includes(row.base)) return [row.base, ...TYPE_SUGGESTIONS]
  return TYPE_SUGGESTIONS
}

async function load() {
  if (!connectionId) return
  loading.value = true
  loadError.value = ''
  try {
    const state = await api.tableEditState(connectionId, props.target.oid)
    table.value = state
    tableDescription.value = state.description ?? ''
    fingerprint.value = state.fingerprint
    // Underscore-prefixed (system-ish) columns render after the ordinary
    // ones, in their original order within each group. Purely visual — the
    // server diff walks the live catalog order, not this display order.
    const loaded = state.columns.map(rowOf)
    const meta = (row: EditRow) => row.name.startsWith('_')
    rows.splice(
      0,
      rows.length,
      ...loaded.filter((row) => !meta(row)),
      ...loaded.filter(meta),
    )
  } catch (e) {
    loadError.value = (e as Error).message
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  window.addEventListener('keydown', onKeydown)
  await load()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
})

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.stopPropagation()
    emit('close')
  }
}

function validate(): string {
  for (const row of rows) {
    if (row.deleted) continue
    if (!row.name.trim()) return 'Every column needs a name'
    if (!row.type.trim()) return `Column "${row.name.trim()}" needs a type`
  }
  const names = new Set<string>()
  for (const row of rows) {
    if (row.deleted) continue
    const name = row.name.trim()
    if (names.has(name)) return `Column name "${name}" is used more than once`
    names.add(name)
  }
  return ''
}

async function submit() {
  if (!connectionId || !table.value || submitting.value) return
  const invalid = validate()
  if (invalid) {
    submitError.value = invalid
    return
  }
  submitError.value = ''
  submitting.value = true
  try {
    const { ddl } = await api.tableEditSubmit(connectionId, props.target.oid, {
      description: tableDescription.value,
      fingerprint: fingerprint.value,
      columns: rows
        .filter((row) => !row.deleted)
        .map((row) => ({
          id: row.id,
          added: row.added,
          name: row.name.trim(),
          type: row.type.trim(),
          nullable: row.nullable,
          defaultValue: row.defaultValue,
          description: row.description,
        })),
    })
    if (ddl === null) {
      toast.show('No changes — the table already matches')
      emit('close')
      return
    }
    tabs.openSqlTab(`Edit ${table.value.name}`, ddl, connectionId)
    emit('close')
  } catch (e) {
    submitError.value = (e as Error).message
  } finally {
    submitting.value = false
  }
}

function onBackdrop() {
  if (!submitting.value) emit('close')
}
</script>

<template>
  <div class="modal-backdrop" @mousedown.self="onBackdrop">
    <div class="modal tableedit-modal">
      <button class="icon tableedit-close" title="Close" @click="emit('close')"><X :size="16" /></button>

      <h2><Table2 :size="16" /> Edit table</h2>

      <div v-if="loading" class="tableedit-status">Loading…</div>
      <div v-else-if="loadError" class="tableedit-status error-text">{{ loadError }}</div>

      <div v-else-if="table" class="tableedit-body">
        <div class="tableedit-name">
          <label class="tableedit-label">Table</label>
          <input :value="`${table.schema}.${table.name}`" readonly />
        </div>

        <label class="tableedit-label" for="tableedit-desc">Description</label>
        <input
          id="tableedit-desc"
          v-model="tableDescription"
          class="tableedit-desc"
          placeholder="Table comment (empty removes it)"
        />

        <div class="tableedit-grid">
          <div class="tableedit-grid-head">
            <span>Name</span><span>Type</span>
            <span title="Length for varchar/char, precision for numeric">Length</span>
            <span title="Scale (numeric only)">Scale</span>
            <span class="center" title="Nullable">Null</span>
            <span class="center" title="Primary key (read-only)">PK</span>
            <span class="center" title="Unique key (read-only)">UK</span>
            <span class="center" title="Foreign key (read-only)">FK</span>
            <span title="Default value">Default</span>
            <span title="Column description">Comment</span>
            <!-- Same 44px the row tools reserve: without it this auto track
                 collapses and every header column drifts left of the rows. -->
            <span class="row-tools"></span>
          </div>
          <div
            v-for="row in rows"
            :key="row.id"
            class="tableedit-row"
            :class="{ deleted: row.deleted, meta: row.name.startsWith('_') }"
          >
            <input v-model="row.name" :readonly="row.deleted" :placeholder="row.added ? 'new column' : row.catalogName" spellcheck="false" />
            <select v-model="row.base" :disabled="row.locked || row.deleted" :title="row.locked ? lockLabel[row.lockKind ?? ''] : 'Column type'" @change="rebuildType(row)">
              <option v-if="!row.base" value="" disabled>— select type —</option>
              <option v-for="t in typeChoices(row)" :key="t" :value="t">{{ t }}</option>
            </select>
            <input
              v-model="row.len"
              type="number"
              min="1"
              class="len"
              :disabled="lenDisabled(row)"
              title="Length (varchar, char) or precision (numeric)"
              @input="rebuildType(row)"
            />
            <input
              v-model="row.scale"
              type="number"
              min="0"
              class="len"
              :disabled="scaleDisabled(row)"
              title="Scale (numeric only)"
              @input="rebuildType(row)"
            />
            <input v-model="row.nullable" type="checkbox" :disabled="nullableDisabled(row) || row.deleted" :title="nullableDisabled(row) ? (row.pk ? 'Primary key columns are NOT NULL' : lockLabel[row.lockKind ?? '']) : 'Nullable'" />
            <span class="flag" :class="{ on: row.pk }" :title="row.pk ? 'Primary key (read-only)' : ''">
              <KeyRound v-if="row.pk" :size="13" />
            </span>
            <span class="fk-chips" :title="ukTooltip(row)">
              <span v-for="u in row.uks" :key="u.label" class="fk-chip" :data-idx="chipIndex(u.label)">{{ u.label }}</span>
            </span>
            <span class="fk-chips" :title="fkTooltip(row)">
              <span v-for="f in row.fks" :key="f.label" class="fk-chip" :data-idx="chipIndex(f.label)">{{ f.label }}</span>
            </span>
            <input v-model="row.defaultValue" :disabled="row.locked || row.deleted" spellcheck="false" :placeholder="row.locked && row.lockKind === 'generated' ? '(generated)' : ''" />
            <input v-model="row.description" :readonly="row.deleted" spellcheck="false" />
            <span class="row-tools">
              <span v-if="row.locked" class="lock" :title="`Read-only: ${lockLabel[row.lockKind ?? '']}`"><Lock :size="12" /></span>
              <button
                v-if="!row.added"
                class="tool"
                :disabled="row.pk"
                :title="row.deleted ? 'Restore column' : row.pk ? 'Primary key columns cannot be dropped' : 'Delete column'"
                @click="toggleDelete(row)"
              >
                <RotateCcw v-if="row.deleted" :size="13" />
                <Trash2 v-else :size="13" />
              </button>
              <template v-if="row.added">
                <span class="added-badge">new</span>
                <button class="tool" title="Remove column" @click="removeRow(row)">
                  <Trash2 :size="13" />
                </button>
              </template>
            </span>
          </div>
        </div>
        <button class="link tableedit-add" @click="addRow"><Plus :size="14" /> Add column</button>

        <div v-if="submitError" class="error-text">{{ submitError }}</div>

        <div class="tableedit-foot">
          <button class="primary" :disabled="submitting" @click="submit">
            {{ submitting ? 'Generating…' : 'Generate DDL' }}
          </button>
          <button class="ghost" :disabled="submitting" @click="emit('close')">Cancel</button>
        </div>
      </div>
    </div>
  </div>
</template>
