<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import {
  ArrowLeft,
  ArrowLeftRight,
  ArrowRight,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleSlash,
  Columns3,
  CornerDownRight,
  Ellipsis,
  Eye,
  Grid2x2,
  KeyRound,
  Link,
  ListTree,
  LoaderCircle,
  RotateCw,
  ShieldCheck,
  Sigma,
  SquareFunction,
  SquareTerminal,
  Table2,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-vue-next'
import { useConnection } from '../composables/connection'
import { useSchema } from '../composables/schema'
import { useTabs } from '../composables/tabs'
import { useToast } from '../composables/toast'
import { api } from '../api'
import { copyText } from '../lib/gridio'
import type { TableInfo } from '../types'

const conn = useConnection()
const schema = useSchema()
const tabs = useTabs()
const toast = useToast()

const open = reactive({ tables: false, views: false, functions: false })
const expanded = reactive(new Set<string>())

type SearchType = 'table' | 'view' | 'function' | 'column'

const TYPE_WORDS: Record<string, SearchType> = {
  table: 'table',
  tables: 'table',
  view: 'view',
  views: 'view',
  function: 'function',
  functions: 'function',
  func: 'function',
  fn: 'function',
  column: 'column',
  columns: 'column',
  col: 'column',
}

const filter = ref('')
const parsed = computed(() => {
  const q = filter.value.trim().toLowerCase()
  if (!q) return { term: '', type: null as SearchType | null }
  const tokens = q.split(/\s+/)
  const last = tokens[tokens.length - 1]
  if (tokens.length > 1 && TYPE_WORDS[last]) {
    return { term: tokens.slice(0, -1).join(' '), type: TYPE_WORDS[last] }
  }
  if (TYPE_WORDS[tokens[0]]) {
    return { term: tokens.slice(1).join(' '), type: TYPE_WORDS[tokens[0]] }
  }
  return { term: q, type: null }
})
const query = computed(() => parsed.value.term)
const searchType = computed(() => parsed.value.type)
const isFiltering = computed(() => filter.value.trim().length > 0)

function nameMatched(name: string, schema: string): boolean {
  return name.toLowerCase().includes(query.value) || schema.toLowerCase().includes(query.value)
}

function colsMatched(cols: { name: string }[]): boolean {
  return cols.some((c) => c.name.toLowerCase().includes(query.value))
}

function autoExpandRel(name: string, schema: string, cols: { name: string }[]): boolean {
  return isFiltering.value && !nameMatched(name, schema) && colsMatched(cols)
}

function autoExpandFunc(name: string, schema: string, typeSig: string): boolean {
  return isFiltering.value && !nameMatched(name, schema) && typeSig.toLowerCase().includes(query.value)
}

const showTables = computed(
  () =>
    !isFiltering.value ||
    searchType.value === null ||
    searchType.value === 'table' ||
    searchType.value === 'column',
)
const showViews = computed(
  () =>
    !isFiltering.value ||
    searchType.value === null ||
    searchType.value === 'view' ||
    searchType.value === 'column',
)
const showFunctions = computed(
  () => !isFiltering.value || searchType.value === null || searchType.value === 'function',
)

const filteredTables = computed(() =>
  showTables.value
    ? tables.value.filter((t) => {
        if (!isFiltering.value) return true
        if (searchType.value === 'column') return colsMatched(t.columns)
        if (searchType.value === 'table') return nameMatched(t.name, t.schema)
        return nameMatched(t.name, t.schema) || colsMatched(t.columns)
      })
    : [],
)
const filteredViews = computed(() =>
  showViews.value
    ? views.value.filter((v) => {
        if (!isFiltering.value) return true
        if (searchType.value === 'column') return colsMatched(v.columns)
        if (searchType.value === 'view') return nameMatched(v.name, v.schema)
        return nameMatched(v.name, v.schema) || colsMatched(v.columns)
      })
    : [],
)
const overloadCounts = computed(() => {
  const counts = new Map<string, number>()
  for (const f of functions.value) counts.set(f.name, (counts.get(f.name) ?? 0) + 1)
  return counts
})
const filteredFunctions = computed(() =>
  showFunctions.value
    ? functions.value.filter(
        (f) =>
          !isFiltering.value ||
          nameMatched(f.name, f.schema) ||
          f.typeSig.toLowerCase().includes(query.value),
      )
    : [],
)
const totalMatches = computed(
  () => filteredTables.value.length + filteredViews.value.length + filteredFunctions.value.length,
)

function toggleChildren(key: string) {
  if (expanded.has(key)) expanded.delete(key)
  else expanded.add(key)
}

const tables = computed(() => schema.state.data?.tables ?? [])
const views = computed(() => schema.state.data?.views ?? [])
const functions = computed(() => schema.state.data?.functions ?? [])

function displayName(schemaName: string, name: string): string {
  return schemaName === 'public' ? name : `${schemaName}.${name}`
}

function isTbd(name: string): boolean {
  return name.includes('_tbd')
}

function splitArgs(args: string): string[] {
  const trimmed = args.trim()
  if (!trimmed) return []
  const parts: string[] = []
  let depth = 0
  let quote: string | null = null
  let cur = ''
  for (const ch of trimmed) {
    if (quote) {
      cur += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      cur += ch
      continue
    }
    if (ch === '(') depth++
    else if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      parts.push(cur.trim())
      cur = ''
    } else {
      cur += ch
    }
  }
  if (cur.trim()) parts.push(cur.trim())
  return parts
}

const PARAM_MODES = ['IN', 'OUT', 'INOUT', 'VARIADIC']

type ParamKind = 'in' | 'out' | 'inout' | 'variadic' | 'returns'

const PARAM_ICONS: Record<ParamKind, LucideIcon> = {
  in: ArrowRight,
  out: ArrowLeft,
  inout: ArrowLeftRight,
  variadic: Ellipsis,
  returns: CornerDownRight,
}

type IndexType = 'primary' | 'unique' | 'exclusion' | 'normal'

const INDEX_ICONS: Record<IndexType, LucideIcon> = {
  primary: KeyRound,
  unique: ShieldCheck,
  exclusion: CircleSlash,
  normal: ListTree,
}

type FunctionKind = 'function' | 'procedure' | 'window' | 'trigger'

const FUNCTION_ICONS: Record<FunctionKind, LucideIcon> = {
  function: SquareFunction,
  procedure: SquareTerminal,
  window: Sigma,
  trigger: Zap,
}

const FUNCTION_LABELS: Record<FunctionKind, string> = {
  function: 'function',
  procedure: 'procedure',
  window: 'window function',
  trigger: 'trigger function',
}

function functionIcon(kind: string | undefined): LucideIcon {
  return FUNCTION_ICONS[(kind ?? 'function') as FunctionKind] ?? SquareFunction
}

const CONSTRAINT_META: Record<string, { icon: LucideIcon; label: string; cls: string }> = {
  p: { icon: KeyRound, label: 'PRIMARY KEY', cls: 'primary' },
  u: { icon: ShieldCheck, label: 'UNIQUE', cls: 'unique' },
  f: { icon: Link, label: 'FOREIGN KEY', cls: 'fk' },
  c: { icon: CircleCheck, label: 'CHECK', cls: 'check' },
  x: { icon: CircleSlash, label: 'EXCLUSION', cls: 'exclusion' },
  n: { icon: CircleAlert, label: 'NOT NULL', cls: 'notnull' },
}

function constraintMeta(type: string): { icon: LucideIcon; label: string; cls: string } {
  return CONSTRAINT_META[type] ?? { icon: CircleAlert, label: type, cls: 'notnull' }
}

function tableTooltip(t: TableInfo): string {
  const base = 'Click to copy name · double-click to open DDL'
  if (t.isPartition) return `Partition of ${t.parents} · ${base}`
  if (t.parents) return `Inherits: ${t.parents} · ${base}`
  if (t.isPartitioned) return `Partitioned table · ${base}`
  return base
}

function tableBadge(t: TableInfo): LucideIcon | null {
  if (t.isPartition || t.parents) return CornerDownRight
  if (t.isPartitioned) return Grid2x2
  return null
}

interface ParamRow {
  kind: ParamKind
  name: string
  rest: string
}

function paramRows(args: string, returns: string): ParamRow[] {
  const rows = splitArgs(args).map((a): ParamRow => {
    const words = a.split(/\s+/)
    let kind: ParamKind = 'in'
    let i = 0
    const first = words[0]?.toUpperCase()
    if (words.length > 1 && PARAM_MODES.includes(first)) {
      kind = first === 'OUT' ? 'out' : first === 'INOUT' ? 'inout' : first === 'VARIADIC' ? 'variadic' : 'in'
      i = 1
    }
    if (words.length > i + 1) {
      return { kind, name: words.slice(i, i + 1).join(' '), rest: words.slice(i + 1).join(' ') }
    }
    return { kind, name: words.length > i ? words.slice(i).join(' ') : a, rest: '' }
  })
  rows.push({ kind: 'returns', name: 'returns', rest: returns })
  return rows
}

async function copyName(schemaName: string | null, name: string) {
  const text = schemaName ? displayName(schemaName, name) : name
  const ok = await copyText(text)
  toast.show(ok ? 'Object name copied.' : 'Copy failed')
}

type TableCategory = 'cols' | 'idx' | 'con' | 'trg'

function tableOpen(t: TableInfo): boolean {
  return expanded.has('t-' + t.oid) || autoExpandRel(t.name, t.schema, t.columns)
}

function catOpen(t: TableInfo, cat: TableCategory): boolean {
  return (
    expanded.has(`t-${t.oid}-${cat}`) ||
    (cat === 'cols' && autoExpandRel(t.name, t.schema, t.columns))
  )
}

async function openObject(
  type: 'table' | 'view' | 'function' | 'index' | 'constraint' | 'trigger',
  schemaName: string,
  name: string,
  oid?: string,
  suffix = '',
  parent?: string,
) {
  if (!conn.state.id) return
  try {
    const { ddl } = await api.ddl(conn.state.id, type, schemaName, name, oid, parent)
    tabs.openDdl(type, schemaName, name, ddl, suffix, type === 'function' || type === 'view')
  } catch (e) {
    toast.show((e as Error).message)
  }
}

async function refresh() {
  if (conn.state.id) await schema.load(conn.state.id)
}
</script>

<template>
  <div class="browser">
    <div v-if="!conn.state.id" class="browser-empty">
      Not connected.<br />Click “Connect” in the top bar.
    </div>

    <template v-else>
      <div class="browser-search">
        <input v-model="filter" placeholder='Search… e.g. "unit table"' />
        <button v-if="filter" class="icon" title="Clear search" @click="filter = ''"><X :size="14" /></button>
        <button
          class="icon"
          :disabled="!conn.state.id || schema.state.loading"
          title="Refresh schema"
          @click="refresh()"
        >
          <LoaderCircle v-if="schema.state.loading" :size="14" class="spin" />
          <RotateCw v-else :size="14" />
        </button>
      </div>
      <div v-if="schema.state.error" class="browser-error">{{ schema.state.error }}</div>

      <section v-if="showTables" class="group">
        <h3 @click="open.tables = !open.tables">
          <component :is="open.tables || isFiltering ? ChevronDown : ChevronRight" class="arrow" :size="11" />
          Tables
          <span class="count">{{ isFiltering ? `${filteredTables.length}/${tables.length}` : tables.length }}</span>
        </h3>
        <template v-if="open.tables || isFiltering">
          <div v-for="t in filteredTables" :key="'t-' + t.oid" class="tree">
            <div
              class="node"
              :title="tableTooltip(t)"
              @click="copyName(t.schema, t.name)"
              @dblclick="openObject('table', t.schema, t.name, t.oid)"
            >
              <span
                class="caret"
                :class="{ open: tableOpen(t) }"
                title="Expand"
                @click.stop="toggleChildren('t-' + t.oid)"
              ><ChevronRight :size="12" /></span>
              <span class="obj-icon">
                <Table2 :size="14" />
                <component
                  :is="tableBadge(t)"
                  v-if="tableBadge(t)"
                  class="obj-badge"
                  :class="t.isPartition || t.parents ? 'child' : 'parent'"
                  :size="9"
                />
              </span>
              <span class="obj-name" :class="{ tbd: isTbd(t.name) }">{{ displayName(t.schema, t.name) }}</span>
            </div>
            <template v-if="tableOpen(t)">
              <div class="node cat" @click="toggleChildren(`t-${t.oid}-cols`)">
                <span
                  class="caret"
                  :class="{ open: catOpen(t, 'cols') }"
                  @click.stop="toggleChildren(`t-${t.oid}-cols`)"
                ><ChevronRight :size="11" /></span>
                <span class="obj-icon"><Columns3 :size="13" /></span>
                <span class="obj-name">Columns</span>
                <span class="count">{{ t.columns.length }}</span>
              </div>
              <template v-if="catOpen(t, 'cols')">
                <div
                  v-for="c in t.columns"
                  :key="c.name"
                  class="node cat-child"
                  title="Click to copy name"
                  @click="copyName(null, c.name)"
                >
                  <span class="obj-name" :class="{ tbd: isTbd(c.name) }">{{ c.name }}</span>
                  <span class="dim">{{ c.type }}</span>
                </div>
                <div v-if="!t.columns.length" class="empty">None</div>
              </template>

              <div class="node cat" @click="toggleChildren(`t-${t.oid}-idx`)">
                <span
                  class="caret"
                  :class="{ open: expanded.has(`t-${t.oid}-idx`) }"
                  @click.stop="toggleChildren(`t-${t.oid}-idx`)"
                ><ChevronRight :size="11" /></span>
                <span class="obj-icon"><ListTree :size="13" /></span>
                <span class="obj-name">Indexes</span>
                <span class="count">{{ t.indexes.length }}</span>
              </div>
              <template v-if="expanded.has(`t-${t.oid}-idx`)">
                <div
                  v-for="ix in t.indexes"
                  :key="ix.name"
                  class="node cat-child"
                  :title="`${ix.type} index · ${ix.method} · double-click to open DDL`"
                  @click="copyName(null, ix.name)"
                  @dblclick="openObject('index', t.schema, ix.name, undefined, '', t.name)"
                >
                  <span class="idx-icon" :class="ix.type"><component :is="INDEX_ICONS[ix.type]" :size="13" /></span>
                  <span class="obj-name" :class="{ tbd: isTbd(ix.name) }">{{ ix.name }}</span>
                  <span class="dim">{{ ix.method }}</span>
                </div>
                <div v-if="!t.indexes.length" class="empty">None</div>
              </template>

              <div class="node cat" @click="toggleChildren(`t-${t.oid}-con`)">
                <span
                  class="caret"
                  :class="{ open: expanded.has(`t-${t.oid}-con`) }"
                  @click.stop="toggleChildren(`t-${t.oid}-con`)"
                ><ChevronRight :size="11" /></span>
                <span class="obj-icon"><KeyRound :size="13" /></span>
                <span class="obj-name">Constraints</span>
                <span class="count">{{ t.constraints.length }}</span>
              </div>
              <template v-if="expanded.has(`t-${t.oid}-con`)">
                <div
                  v-for="con in t.constraints"
                  :key="con.name"
                  class="node cat-child"
                  :title="`${constraintMeta(con.type).label}: ${con.definition} · double-click to open DDL`"
                  @click="copyName(null, con.name)"
                  @dblclick="openObject('constraint', t.schema, con.name, undefined, '', t.name)"
                >
                  <span class="con-icon" :class="constraintMeta(con.type).cls"><component :is="constraintMeta(con.type).icon" :size="13" /></span>
                  <span class="obj-name" :class="{ tbd: isTbd(con.name) }">{{ con.name }}</span>
                </div>
                <div v-if="!t.constraints.length" class="empty">None</div>
              </template>

              <div class="node cat" @click="toggleChildren(`t-${t.oid}-trg`)">
                <span
                  class="caret"
                  :class="{ open: expanded.has(`t-${t.oid}-trg`) }"
                  @click.stop="toggleChildren(`t-${t.oid}-trg`)"
                ><ChevronRight :size="11" /></span>
                <span class="obj-icon"><Zap :size="13" /></span>
                <span class="obj-name">Triggers</span>
                <span class="count">{{ t.triggers.length }}</span>
              </div>
              <template v-if="expanded.has(`t-${t.oid}-trg`)">
                <div
                  v-for="trg in t.triggers"
                  :key="trg.name"
                  class="node cat-child"
                  title="Click to copy name · double-click to open DDL"
                  @click="copyName(null, trg.name)"
                  @dblclick="openObject('trigger', t.schema, trg.name, undefined, '', t.name)"
                >
                  <span class="obj-name" :class="{ tbd: isTbd(trg.name) }">{{ trg.name }}</span>
                </div>
                <div v-if="!t.triggers.length" class="empty">None</div>
              </template>
            </template>
          </div>
          <div v-if="!filteredTables.length" class="empty">No tables</div>
        </template>
      </section>

      <section v-if="showViews" class="group">
        <h3 @click="open.views = !open.views">
          <component :is="open.views || isFiltering ? ChevronDown : ChevronRight" class="arrow" :size="11" />
          Views
          <span class="count">{{ isFiltering ? `${filteredViews.length}/${views.length}` : views.length }}</span>
        </h3>
        <template v-if="open.views || isFiltering">
          <div v-for="v in filteredViews" :key="'v-' + v.oid" class="tree">
            <div class="node" title="Click to copy name · double-click to open DDL" @click="copyName(v.schema, v.name)" @dblclick="openObject('view', v.schema, v.name, v.oid)">
              <span
                class="caret"
                :class="{ open: expanded.has('v-' + v.oid) || autoExpandRel(v.name, v.schema, v.columns) }"
                title="Toggle columns"
                @click.stop="toggleChildren('v-' + v.oid)"
              >▸</span>
              <span class="obj-icon"><Eye :size="14" /></span>
              <span class="obj-name" :class="{ tbd: isTbd(v.name) }">{{ displayName(v.schema, v.name) }}</span>
              <span v-if="v.materialized" class="void-badge">mat</span>
            </div>
            <template v-if="expanded.has('v-' + v.oid) || autoExpandRel(v.name, v.schema, v.columns)">
              <div v-for="c in v.columns" :key="c.name" class="node child">
                <span class="obj-name">{{ c.name }}</span>
                <span class="dim">{{ c.type }}</span>
              </div>
            </template>
          </div>
          <div v-if="!filteredViews.length" class="empty">No views</div>
        </template>
      </section>

      <section v-if="showFunctions" class="group">
        <h3 @click="open.functions = !open.functions">
          <component :is="open.functions || isFiltering ? ChevronDown : ChevronRight" class="arrow" :size="11" />
          Functions
          <span class="count">{{ isFiltering ? `${filteredFunctions.length}/${functions.length}` : functions.length }}</span>
        </h3>
        <template v-if="open.functions || isFiltering">
          <div v-for="f in filteredFunctions" :key="'f-' + f.oid" class="tree">
            <div
              class="node"
              :title="`${FUNCTION_LABELS[(f.kind ?? 'function') as FunctionKind] ?? 'function'} · args: (${f.args}) · returns: ${f.returns} · Click to copy name · double-click to open DDL`"
              @click="copyName(f.schema, f.name)"
              @dblclick="openObject('function', f.schema, f.name, f.oid, f.typeSig ? `(${f.typeSig})` : '')"
            >
              <span
                class="caret"
                :class="{ open: expanded.has('f-' + f.oid) || autoExpandFunc(f.name, f.schema, f.typeSig) }"
                title="Toggle signature"
                @click.stop="toggleChildren('f-' + f.oid)"
              >▸</span>
              <span class="obj-icon"><component :is="functionIcon(f.kind)" :size="14" /></span>
              <span class="obj-name" :class="{ tbd: isTbd(f.name) }">{{ displayName(f.schema, f.name) }}</span>
              <span v-if="f.returns === 'void'" class="void-badge">void</span>
              <span v-if="(overloadCounts.get(f.name) ?? 0) > 1" class="void-badge overload-badge">overload</span>
            </div>
            <template v-if="expanded.has('f-' + f.oid) || autoExpandFunc(f.name, f.schema, f.typeSig)">
              <div v-for="(p, i) in paramRows(f.args, f.returns)" :key="'p-' + i" class="node child">
                <span class="param-icon" :class="p.kind"><component :is="PARAM_ICONS[p.kind]" :size="14" /></span>
                <span class="obj-name">{{ p.name }}</span>
                <span v-if="p.rest" class="dim">{{ p.rest }}</span>
              </div>
            </template>
          </div>
          <div v-if="!filteredFunctions.length" class="empty">No functions</div>
        </template>
      </section>

      <div v-if="isFiltering && !totalMatches" class="empty no-match">
        No objects match “{{ filter }}”
      </div>
    </template>
  </div>
</template>
