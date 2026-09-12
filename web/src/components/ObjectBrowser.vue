<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
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
  FileText,
  Folder,
  FolderOpen,
  Grid2x2,
  KeyRound,
  Link,
  ListTree,
  LoaderCircle,
  Pin,
  RotateCw,
  ShieldCheck,
  Shapes,
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
import { useSettings } from '../composables/settings'
import { useTabs } from '../composables/tabs'
import { useToast } from '../composables/toast'
import { api } from '../api'
import type { TableInfo } from '../types'
import { groupTables, type TableEntry } from '../lib/tablegroups'
import { groupNamedObjects } from '../lib/objectgroups'

const conn = useConnection()
const schema = useSchema()
const settings = useSettings()
const tabs = useTabs()
const toast = useToast()

const open = reactive({ tables: false, views: false, functions: false, types: false })
const expanded = reactive(new Set<string>())

type SearchType = 'table' | 'view' | 'function' | 'column' | 'parameter' | 'type'

type BrowserNodeType =
  | 'section'
  | 'table-group'
  | 'table'
  | 'table-category'
  | 'table-column'
  | 'table-index'
  | 'table-constraint'
  | 'table-trigger'
  | 'view-group'
  | 'view'
  | 'view-column'
  | 'type-group'
  | 'type'
  | 'type-detail'
  | 'function-group'
  | 'function'
  | 'function-parameter'

interface BrowserNode {
  type: BrowserNodeType
  key: string
  collapseKeys: string[]
  section?: BrowserSection
  groupKeys?: string[]
  groupState?: Set<string>
}

type BrowserSection = 'tables' | 'views' | 'types' | 'functions'

interface BrowserContextMenu {
  x: number
  y: number
  node: BrowserNode
}

interface PinnedContextMenu {
  x: number
  y: number
  id: string
}

const contextMenu = ref<BrowserContextMenu | null>(null)
const pinnedContextMenu = ref<PinnedContextMenu | null>(null)

function browserNode(type: BrowserNodeType, key: string, collapseKeys = [key], groupState?: Set<string>): BrowserNode {
  return { type, key, collapseKeys, groupState }
}

function openNodeMenu(e: MouseEvent, node: BrowserNode) {
  e.preventDefault()
  e.stopPropagation()
  cancelPendingToggle()
  pinnedContextMenu.value = null

  const width = 150
  const height = 36
  contextMenu.value = {
    x: Math.min(e.clientX, Math.max(8, window.innerWidth - width - 8)),
    y: Math.min(e.clientY, Math.max(8, window.innerHeight - height - 8)),
    node,
  }
}

function openPinnedMenu(e: MouseEvent, id: string) {
  e.preventDefault()
  e.stopPropagation()
  cancelPendingToggle()
  contextMenu.value = null

  const width = 150
  const height = 36
  pinnedContextMenu.value = {
    x: Math.min(e.clientX, Math.max(8, window.innerWidth - width - 8)),
    y: Math.min(e.clientY, Math.max(8, window.innerHeight - height - 8)),
    id,
  }
}

function collapseNode(node: BrowserNode) {
  node.groupState?.delete(node.key)
  if (node.type === 'section' && node.section) open[node.section] = false
  for (const key of node.groupKeys ?? []) (node.groupState ?? expandedTableGroups).delete(key)

  for (const root of node.collapseKeys) {
    for (const key of expanded) {
      if (key === root || key.startsWith(`${root}-`)) expanded.delete(key)
    }
  }
}

function collapseContextNode() {
  const node = contextMenu.value?.node
  if (node) collapseNode(node)
  contextMenu.value = null
}

function unpinContextFile() {
  const id = pinnedContextMenu.value?.id
  pinnedContextMenu.value = null
  if (id) void tabs.unpinFile(id)
}

async function openPinnedFile(id: string) {
  const result = await tabs.openPinned(id)
  if (result === 'fallback') {
    const pin = tabs.state.pinnedFiles.find((entry) => entry.id === id)
    toast.show(`Could not read "${pin?.fileName ?? 'pinned file'}"; opened its last saved copy`)
  }
}

function closeContextMenus() {
  contextMenu.value = null
  pinnedContextMenu.value = null
}

function onGlobalKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') closeContextMenus()
}

onMounted(() => {
  window.addEventListener('click', closeContextMenus)
  window.addEventListener('keydown', onGlobalKeydown)
})

onBeforeUnmount(() => {
  window.removeEventListener('click', closeContextMenus)
  window.removeEventListener('keydown', onGlobalKeydown)
})

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
  param: 'parameter',
  params: 'parameter',
  parameter: 'parameter',
  parameters: 'parameter',
  type: 'type',
  types: 'type',
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
const queryTerms = computed(() => parsed.value.term.split(/[+\s]+/).filter(Boolean))
const searchType = computed(() => parsed.value.type)
const isFiltering = computed(() => filter.value.trim().length > 0)

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char] ?? char)
}

function highlightText(value: string): string {
  const terms = [...new Set(queryTerms.value)].sort((a, b) => b.length - a.length)
  if (!terms.length) return escapeHtml(value)

  const pattern = new RegExp(terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi')
  let result = ''
  let lastIndex = 0
  for (const match of value.matchAll(pattern)) {
    const index = match.index ?? 0
    result += escapeHtml(value.slice(lastIndex, index))
    result += `<mark class="search-hit">${escapeHtml(match[0])}</mark>`
    lastIndex = index + match[0].length
  }
  return result + escapeHtml(value.slice(lastIndex))
}

function matchesAll(value: string): boolean {
  const candidate = value.toLowerCase()
  return queryTerms.value.every((term) => candidate.includes(term))
}

function nameMatched(name: string, schema: string): boolean {
  const nameText = name.toLowerCase()
  const schemaText = schema.toLowerCase()
  return queryTerms.value.every((term) => nameText.includes(term) || schemaText.includes(term))
}

function colsMatched(cols: { name: string }[]): boolean {
  return cols.some((c) => matchesAll(c.name))
}

function paramsMatched(args: string): boolean {
  return paramRows(args, '').some((p) => p.kind !== 'returns' && matchesAll(p.name))
}

function autoExpandRel(name: string, schema: string, cols: { name: string }[]): boolean {
  return isFiltering.value && !nameMatched(name, schema) && colsMatched(cols)
}

function autoExpandFunc(name: string, schema: string, typeSig: string, args: string): boolean {
  return (
    isFiltering.value &&
    !nameMatched(name, schema) &&
    (matchesAll(typeSig) || paramsMatched(args))
  )
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
  () => !isFiltering.value || searchType.value === null || searchType.value === 'function' || searchType.value === 'parameter',
)
const showTypes = computed(
  () => !isFiltering.value || searchType.value === null || searchType.value === 'type',
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
  for (const f of functions.value) counts.set(`${f.schema}.${f.name}`, (counts.get(`${f.schema}.${f.name}`) ?? 0) + 1)
  return counts
})
const filteredFunctions = computed(() =>
  showFunctions.value
    ? functions.value.filter(
        (f) =>
          !isFiltering.value ||
          (searchType.value === 'parameter'
            ? paramsMatched(f.args)
            : nameMatched(f.name, f.schema) ||
              matchesAll(f.typeSig) ||
              (searchType.value === null && paramsMatched(f.args))),
      )
    : [],
)
const types = computed(() => schema.state.data?.types ?? [])
const filteredTypes = computed(() =>
  showTypes.value
    ? types.value.filter(
        (t) =>
           !isFiltering.value ||
           nameMatched(t.name, t.schema) ||
           matchesAll(t.detail),
      )
    : [],
)
const totalMatches = computed(
  () =>
    filteredTables.value.length +
    filteredViews.value.length +
    filteredFunctions.value.length +
    filteredTypes.value.length,
)

function flip(key: string) {
  if (expanded.has(key)) expanded.delete(key)
  else expanded.add(key)
}

function toggleChildren(key: string) {
  // Any explicit toggle wins over a pending delayed one.
  window.clearTimeout(clickTimer)
  pendingToggle = null
  flip(key)
}

// Row-body single clicks toggle on a delay so a double-click (open DDL)
// never flips expand state: the 2nd click (detail > 1) is ignored and
// dblclick cancels the pending toggle — or reverts it if a slow 2nd
// click already let it fire.
let clickTimer = 0
let pendingToggle: { key: string; fired: boolean; at: number } | null = null

function queueToggle(e: MouseEvent, key: string) {
  if (e.detail !== 1) return
  window.clearTimeout(clickTimer)
  pendingToggle = { key, fired: false, at: Date.now() }
  clickTimer = window.setTimeout(() => {
    flip(key)
    if (pendingToggle && pendingToggle.key === key) pendingToggle.fired = true
  }, 300)
}

function cancelPendingToggle() {
  window.clearTimeout(clickTimer)
  if (pendingToggle && Date.now() - pendingToggle.at < 600) {
    if (pendingToggle.fired) flip(pendingToggle.key)
  }
  pendingToggle = null
}

const tables = computed(() => schema.state.data?.tables ?? [])
const views = computed(() => schema.state.data?.views ?? [])
const functions = computed(() => schema.state.data?.functions ?? [])
const expandedTableGroups = reactive(new Set<string>())
const expandedViewGroups = reactive(new Set<string>())
const expandedFunctionGroups = reactive(new Set<string>())
const expandedTypeGroups = reactive(new Set<string>())
const tableEntries = computed(() => groupTables(filteredTables.value, settings.state.groupObjects))
const viewEntries = computed(() => groupNamedObjects(filteredViews.value, settings.state.groupObjects, 'view'))
const functionEntries = computed(() => groupNamedObjects(filteredFunctions.value, settings.state.groupObjects, 'function'))
const typeEntries = computed(() => groupNamedObjects(filteredTypes.value, settings.state.groupObjects, 'type'))

function sectionNode(section: BrowserSection): BrowserNode {
  const collapseKeys =
    section === 'tables'
      ? tables.value.map((table) => `t-${table.oid}`)
      : section === 'views'
        ? views.value.map((view) => `v-${view.oid}`)
        : section === 'types'
          ? types.value.map((type) => `ty-${type.oid}`)
          : functions.value.map((func) => `f-${func.oid}`)
  const groupKeys =
    section === 'tables'
      ? groupTables(tables.value, settings.state.groupObjects)
          .filter((entry) => entry.kind === 'group')
          .map((entry) => entry.key)
      : section === 'views'
        ? viewEntries.value.filter((entry) => entry.kind === 'group').map((entry) => entry.key)
        : section === 'types'
          ? typeEntries.value.filter((entry) => entry.kind === 'group').map((entry) => entry.key)
          : functionEntries.value.filter((entry) => entry.kind === 'group').map((entry) => entry.key)
  const groupState =
    section === 'tables'
      ? expandedTableGroups
      : section === 'views'
        ? expandedViewGroups
        : section === 'types'
          ? expandedTypeGroups
          : expandedFunctionGroups
  return { ...browserNode('section', `section-${section}`, collapseKeys, groupState), section, groupKeys }
}

function tableGroupOpen(entry: TableEntry): boolean {
  return entry.kind === 'table' || expandedTableGroups.has(entry.key) || (isFiltering.value && entry.kind === 'group')
}

function toggleTableGroup(key: string) {
  if (expandedTableGroups.has(key)) expandedTableGroups.delete(key)
  else expandedTableGroups.add(key)
}

function objectGroupOpen(entry: { kind: 'group' | 'item'; key: string }, groups: Set<string>): boolean {
  return entry.kind === 'item' || groups.has(entry.key) || (isFiltering.value && entry.kind === 'group')
}

function toggleObjectGroup(key: string, groups: Set<string>) {
  if (groups.has(key)) groups.delete(key)
  else groups.add(key)
}

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
  const base = 'Click to expand/collapse · double-click to open DDL'
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
  type: 'table' | 'view' | 'function' | 'index' | 'constraint' | 'trigger' | 'type',
  schemaName: string,
  name: string,
  oid?: string,
  identitySuffix = '',
  parent?: string,
) {
  cancelPendingToggle()
  const connectionId = conn.state.id
  if (!connectionId) return
  try {
    const { ddl } = await api.ddl(connectionId, type, schemaName, name, oid, parent)
    if (conn.state.id !== connectionId) return
    // Function/view DDL is CREATE OR REPLACE (re-runnable), and index/
    // trigger/type DDL ships with a commented DROP line, so those tabs are
    // editable; tables and constraints stay read-only previews. Re-opening
    // refreshes content.
    const editable = type === 'function' || type === 'view' || type === 'index' || type === 'trigger' || type === 'type'
    const identity = oid ? `--${oid}` : identitySuffix
    tabs.openDdl(type, schemaName, name, ddl, identity, editable, parent ?? '')
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
    <div class="browser-main">
      <div v-if="!conn.state.id" class="browser-empty">
        Not connected.<br />Click “Connect” in the top bar.
      </div>

      <template v-else>
        <div class="browser-search">
          <input v-model="filter" placeholder='Search… e.g. "unit table", "id col", "user param"' />
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
        <h3 @click="open.tables = !open.tables" @contextmenu="openNodeMenu($event, sectionNode('tables'))">
          <component :is="open.tables || isFiltering ? ChevronDown : ChevronRight" class="arrow" :size="11" />
          Tables
          <span class="count">{{ isFiltering ? `${filteredTables.length}/${tables.length}` : tables.length }}</span>
        </h3>
        <template v-if="open.tables || isFiltering">
          <template v-for="entry in tableEntries" :key="entry.key">
            <div
              v-if="entry.kind === 'group'"
              class="node object-group-node"
              :title="`${displayName(entry.schema, entry.name)} · ${entry.tables.length} tables`"
              @click="toggleTableGroup(entry.key)"
              @contextmenu="openNodeMenu($event, browserNode('table-group', entry.key, entry.tables.map((t) => 't-' + t.oid), expandedTableGroups))"
            >
              <span class="caret" :class="{ open: tableGroupOpen(entry) }"><ChevronRight :size="12" /></span>
              <span class="obj-icon"><component :is="tableGroupOpen(entry) ? FolderOpen : Folder" :size="14" /></span>
              <span class="obj-name" v-html="highlightText(displayName(entry.schema, entry.name))" />
              <span class="node-badges"></span>
              <span class="count">{{ entry.tables.length }}</span>
            </div>
            <template v-if="tableGroupOpen(entry)">
              <div class="object-entry-children" :class="{ 'object-group-children': entry.kind === 'group' }">
                <div v-for="t in entry.tables" :key="'t-' + t.oid" class="tree">
                  <div
                    class="node"
                    :title="tableTooltip(t)"
                    @click="queueToggle($event, 't-' + t.oid)"
                    @dblclick="openObject('table', t.schema, t.name, t.oid)"
                    @contextmenu="openNodeMenu($event, browserNode('table', 't-' + t.oid))"
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
                        :size="12"
                      />
                    </span>
                    <span class="obj-name" v-html="highlightText(displayName(t.schema, t.name))" />
                    <span class="node-badges">
                      <span v-if="isTbd(t.name)" class="void-badge tbd-badge">tbd</span>
                    </span>
                  </div>
                  <template v-if="tableOpen(t)">
                    <div class="node cat" @click="toggleChildren(`t-${t.oid}-cols`)" @contextmenu="openNodeMenu($event, browserNode('table-category', `t-${t.oid}-cols`))">
                      <span
                        class="caret"
                        :class="{ open: catOpen(t, 'cols') }"
                        @click.stop="toggleChildren(`t-${t.oid}-cols`)"
                      ><ChevronRight :size="11" /></span>
                      <span class="obj-icon"><Columns3 :size="13" /></span>
                      <span class="obj-name">Columns</span>
                      <span class="node-badges"></span>
                      <span class="count">{{ t.columns.length }}</span>
                    </div>
                    <template v-if="catOpen(t, 'cols')">
                      <div
                        v-for="c in t.columns"
                        :key="c.name"
                        class="node cat-child typed-row"
                        :title="`${c.name} · ${c.type}`"
                        @contextmenu="openNodeMenu($event, browserNode('table-column', `t-${t.oid}-cols-${c.name}`, []))"
                      >
                        <span class="obj-name" v-html="highlightText(c.name)" />
                        <span class="node-badges"><span v-if="isTbd(c.name)" class="void-badge tbd-badge">tbd</span></span>
                        <span class="dim">{{ c.type }}</span>
                      </div>
                      <div v-if="!t.columns.length" class="empty">None</div>
                    </template>

                    <div class="node cat" @click="toggleChildren(`t-${t.oid}-idx`)" @contextmenu="openNodeMenu($event, browserNode('table-category', `t-${t.oid}-idx`))">
                      <span
                        class="caret"
                        :class="{ open: expanded.has(`t-${t.oid}-idx`) }"
                        @click.stop="toggleChildren(`t-${t.oid}-idx`)"
                      ><ChevronRight :size="11" /></span>
                      <span class="obj-icon"><ListTree :size="13" /></span>
                      <span class="obj-name">Indexes</span>
                      <span class="node-badges"></span>
                      <span class="count">{{ t.indexes.length }}</span>
                    </div>
                    <template v-if="expanded.has(`t-${t.oid}-idx`)">
                      <div
                        v-for="ix in t.indexes"
                        :key="ix.name"
                        class="node cat-child typed-row"
                        :title="`${ix.type} index · ${ix.method} · double-click to open DDL`"
                        @dblclick="openObject('index', t.schema, ix.name, undefined, '', t.name)"
                        @contextmenu="openNodeMenu($event, browserNode('table-index', `t-${t.oid}-idx-${ix.name}`, []))"
                      >
                        <span class="idx-icon" :class="ix.type"><component :is="INDEX_ICONS[ix.type]" :size="13" /></span>
                        <span class="obj-name" v-html="highlightText(ix.name)" />
                        <span class="node-badges"><span v-if="isTbd(ix.name)" class="void-badge tbd-badge">tbd</span></span>
                        <span class="dim">{{ ix.method }}</span>
                      </div>
                      <div v-if="!t.indexes.length" class="empty">None</div>
                    </template>

                    <div class="node cat" @click="toggleChildren(`t-${t.oid}-con`)" @contextmenu="openNodeMenu($event, browserNode('table-category', `t-${t.oid}-con`))">
                      <span
                        class="caret"
                        :class="{ open: expanded.has(`t-${t.oid}-con`) }"
                        @click.stop="toggleChildren(`t-${t.oid}-con`)"
                      ><ChevronRight :size="11" /></span>
                      <span class="obj-icon"><KeyRound :size="13" /></span>
                      <span class="obj-name">Constraints</span>
                      <span class="node-badges"></span>
                      <span class="count">{{ t.constraints.length }}</span>
                    </div>
                    <template v-if="expanded.has(`t-${t.oid}-con`)">
                      <div
                        v-for="con in t.constraints"
                        :key="con.name"
                        class="node cat-child"
                        :title="`${constraintMeta(con.type).label}: ${con.definition} · double-click to open DDL`"
                        @dblclick="openObject('constraint', t.schema, con.name, undefined, '', t.name)"
                        @contextmenu="openNodeMenu($event, browserNode('table-constraint', `t-${t.oid}-con-${con.name}`, []))"
                      >
                        <span class="con-icon" :class="constraintMeta(con.type).cls"><component :is="constraintMeta(con.type).icon" :size="13" /></span>
                        <span class="obj-name" v-html="highlightText(con.name)" />
                        <span class="node-badges"><span v-if="isTbd(con.name)" class="void-badge tbd-badge">tbd</span></span>
                      </div>
                      <div v-if="!t.constraints.length" class="empty">None</div>
                    </template>

                    <div class="node cat" @click="toggleChildren(`t-${t.oid}-trg`)" @contextmenu="openNodeMenu($event, browserNode('table-category', `t-${t.oid}-trg`))">
                      <span
                        class="caret"
                        :class="{ open: expanded.has(`t-${t.oid}-trg`) }"
                        @click.stop="toggleChildren(`t-${t.oid}-trg`)"
                      ><ChevronRight :size="11" /></span>
                      <span class="obj-icon"><Zap :size="13" /></span>
                      <span class="obj-name">Triggers</span>
                      <span class="node-badges"></span>
                      <span class="count">{{ t.triggers.length }}</span>
                    </div>
                    <template v-if="expanded.has(`t-${t.oid}-trg`)">
                      <div
                        v-for="trg in t.triggers"
                        :key="trg.name"
                        class="node cat-child"
                        title="Double-click to open DDL"
                        @dblclick="openObject('trigger', t.schema, trg.name, undefined, '', t.name)"
                        @contextmenu="openNodeMenu($event, browserNode('table-trigger', `t-${t.oid}-trg-${trg.name}`, []))"
                      >
                        <span class="obj-name" v-html="highlightText(trg.name)" />
                        <span class="node-badges"><span v-if="isTbd(trg.name)" class="void-badge tbd-badge">tbd</span></span>
                      </div>
                      <div v-if="!t.triggers.length" class="empty">None</div>
                    </template>
                  </template>
                </div>
              </div>
            </template>
          </template>
          <div v-if="!filteredTables.length" class="empty">No tables</div>
        </template>
      </section>

      <section v-if="showViews" class="group">
        <h3 @click="open.views = !open.views" @contextmenu="openNodeMenu($event, sectionNode('views'))">
          <component :is="open.views || isFiltering ? ChevronDown : ChevronRight" class="arrow" :size="11" />
          Views
          <span class="count">{{ isFiltering ? `${filteredViews.length}/${views.length}` : views.length }}</span>
        </h3>
        <template v-if="open.views || isFiltering">
          <template v-for="entry in viewEntries" :key="entry.key">
            <div
              v-if="entry.kind === 'group'"
              class="node object-group-node"
              :title="`${displayName(entry.schema, entry.name)} · ${entry.objects.length} views`"
              @click="toggleObjectGroup(entry.key, expandedViewGroups)"
              @contextmenu="openNodeMenu($event, browserNode('view-group', entry.key, entry.objects.map((v) => 'v-' + v.oid), expandedViewGroups))"
            >
              <span class="caret" :class="{ open: objectGroupOpen(entry, expandedViewGroups) }"><ChevronRight :size="12" /></span>
              <span class="obj-icon"><component :is="objectGroupOpen(entry, expandedViewGroups) ? FolderOpen : Folder" :size="14" /></span>
              <span class="obj-name" v-html="highlightText(displayName(entry.schema, entry.name))" />
              <span class="node-badges"></span>
              <span class="count">{{ entry.objects.length }}</span>
            </div>
            <template v-if="objectGroupOpen(entry, expandedViewGroups)">
              <div class="object-entry-children" :class="{ 'object-group-children': entry.kind === 'group' }">
                <div v-for="v in entry.objects" :key="'v-' + v.oid" class="tree">
                  <div class="node" title="Click to expand/collapse · double-click to open DDL" @click="queueToggle($event, 'v-' + v.oid)" @dblclick="openObject('view', v.schema, v.name, v.oid)" @contextmenu="openNodeMenu($event, browserNode('view', 'v-' + v.oid))">
                    <span
                      class="caret"
                      :class="{ open: expanded.has('v-' + v.oid) || autoExpandRel(v.name, v.schema, v.columns) }"
                      title="Toggle columns"
                      @click.stop="toggleChildren('v-' + v.oid)"
                    ><ChevronRight :size="12" /></span>
                    <span class="obj-icon"><Eye :size="14" /></span>
                    <span class="obj-name" v-html="highlightText(displayName(v.schema, v.name))" />
                    <span class="node-badges"><span v-if="v.materialized" class="void-badge">mat</span><span v-if="isTbd(v.name)" class="void-badge tbd-badge">tbd</span></span>
                  </div>
                  <template v-if="expanded.has('v-' + v.oid) || autoExpandRel(v.name, v.schema, v.columns)">
                    <div
                      v-for="c in v.columns"
                      :key="c.name"
                      class="node child typed-row"
                      :title="`${c.name} · ${c.type}`"
                      @contextmenu="openNodeMenu($event, browserNode('view-column', `v-${v.oid}-${c.name}`, []))"
                    >
                      <span class="obj-name" v-html="highlightText(c.name)" />
                      <span class="node-badges"></span>
                      <span class="dim">{{ c.type }}</span>
                    </div>
                  </template>
                </div>
              </div>
            </template>
          </template>
          <div v-if="!filteredViews.length" class="empty">No views</div>
        </template>
      </section>

      <section v-if="showTypes" class="group">
        <h3 @click="open.types = !open.types" @contextmenu="openNodeMenu($event, sectionNode('types'))">
          <component :is="open.types || isFiltering ? ChevronDown : ChevronRight" class="arrow" :size="11" />
          Types
          <span class="count">{{ isFiltering ? `${filteredTypes.length}/${types.length}` : types.length }}</span>
        </h3>
        <template v-if="open.types || isFiltering">
          <template v-for="entry in typeEntries" :key="entry.key">
            <div
              v-if="entry.kind === 'group'"
              class="node object-group-node"
              :title="`${displayName(entry.schema, entry.name)} · ${entry.objects.length} types`"
              @click="toggleObjectGroup(entry.key, expandedTypeGroups)"
              @contextmenu="openNodeMenu($event, browserNode('type-group', entry.key, entry.objects.map((t) => 'ty-' + t.oid), expandedTypeGroups))"
            >
              <span class="caret" :class="{ open: objectGroupOpen(entry, expandedTypeGroups) }"><ChevronRight :size="12" /></span>
              <span class="obj-icon"><component :is="objectGroupOpen(entry, expandedTypeGroups) ? FolderOpen : Folder" :size="14" /></span>
              <span class="obj-name" v-html="highlightText(displayName(entry.schema, entry.name))" />
              <span class="node-badges"></span>
              <span class="count">{{ entry.objects.length }}</span>
            </div>
            <template v-if="objectGroupOpen(entry, expandedTypeGroups)">
              <div class="object-entry-children" :class="{ 'object-group-children': entry.kind === 'group' }">
                <div v-for="t in entry.objects" :key="'ty-' + t.oid" class="tree">
                  <div
                    class="node"
                    :title="`${t.kind} · ${t.detail} · Click to expand/collapse · double-click to open DDL`"
                    @click="queueToggle($event, 'ty-' + t.oid)"
                    @dblclick="openObject('type', t.schema, t.name, t.oid)"
                    @contextmenu="openNodeMenu($event, browserNode('type', 'ty-' + t.oid))"
                  >
                    <span
                      class="caret"
                      :class="{ open: expanded.has('ty-' + t.oid) }"
                      title="Toggle detail"
                      @click.stop="toggleChildren('ty-' + t.oid)"
                    ><ChevronRight :size="12" /></span>
                    <span class="obj-icon"><Shapes :size="14" /></span>
                    <span class="obj-name" v-html="highlightText(displayName(t.schema, t.name))" />
                    <span class="node-badges"><span class="void-badge">{{ t.kind }}</span><span v-if="isTbd(t.name)" class="void-badge tbd-badge">tbd</span></span>
                  </div>
                  <template v-if="expanded.has('ty-' + t.oid)">
                    <div class="node child" :title="t.detail" @contextmenu="openNodeMenu($event, browserNode('type-detail', `ty-${t.oid}-detail`, []))">
                      <span class="obj-name" v-html="highlightText(t.detail || '—')" />
                      <span class="node-badges"></span>
                    </div>
                  </template>
                </div>
              </div>
            </template>
          </template>
          <div v-if="!filteredTypes.length" class="empty">No types</div>
        </template>
      </section>

      <section v-if="showFunctions" class="group">
        <h3 @click="open.functions = !open.functions" @contextmenu="openNodeMenu($event, sectionNode('functions'))">
          <component :is="open.functions || isFiltering ? ChevronDown : ChevronRight" class="arrow" :size="11" />
          Functions
          <span class="count">{{ isFiltering ? `${filteredFunctions.length}/${functions.length}` : functions.length }}</span>
        </h3>
        <template v-if="open.functions || isFiltering">
          <template v-for="entry in functionEntries" :key="entry.key">
            <div
              v-if="entry.kind === 'group'"
              class="node object-group-node"
              :title="`${displayName(entry.schema, entry.name)} · ${entry.objects.length} functions`"
              @click="toggleObjectGroup(entry.key, expandedFunctionGroups)"
              @contextmenu="openNodeMenu($event, browserNode('function-group', entry.key, entry.objects.map((f) => 'f-' + f.oid), expandedFunctionGroups))"
            >
              <span class="caret" :class="{ open: objectGroupOpen(entry, expandedFunctionGroups) }"><ChevronRight :size="12" /></span>
              <span class="obj-icon"><component :is="objectGroupOpen(entry, expandedFunctionGroups) ? FolderOpen : Folder" :size="14" /></span>
              <span class="obj-name" v-html="highlightText(displayName(entry.schema, entry.name))" />
              <span class="node-badges"></span>
              <span class="count">{{ entry.objects.length }}</span>
            </div>
            <template v-if="objectGroupOpen(entry, expandedFunctionGroups)">
              <div class="object-entry-children" :class="{ 'object-group-children': entry.kind === 'group' }">
                <div v-for="f in entry.objects" :key="'f-' + f.oid" class="tree">
                  <div
                    class="node"
                    :title="`${FUNCTION_LABELS[(f.kind ?? 'function') as FunctionKind] ?? 'function'} · args: (${f.args}) · returns: ${f.returns} · Click to expand/collapse · double-click to open DDL`"
                    @click="queueToggle($event, 'f-' + f.oid)"
                    @dblclick="openObject('function', f.schema, f.name, f.oid, f.typeSig ? `(${f.typeSig})` : '')"
                    @contextmenu="openNodeMenu($event, browserNode('function', 'f-' + f.oid))"
                  >
                    <span
                      class="caret"
                      :class="{ open: expanded.has('f-' + f.oid) || autoExpandFunc(f.name, f.schema, f.typeSig, f.args) }"
                      title="Toggle signature"
                      @click.stop="toggleChildren('f-' + f.oid)"
                    ><ChevronRight :size="12" /></span>
                    <span class="obj-icon"><component :is="functionIcon(f.kind)" :size="14" /></span>
                    <span class="obj-name" v-html="highlightText(displayName(f.schema, f.name))" />
                    <span class="node-badges"><span v-if="f.returns === 'void'" class="void-badge">void</span><span v-if="(overloadCounts.get(`${f.schema}.${f.name}`) ?? 0) > 1" class="void-badge overload-badge">overload</span><span v-if="isTbd(f.name)" class="void-badge tbd-badge">tbd</span></span>
                  </div>
                  <template v-if="expanded.has('f-' + f.oid) || autoExpandFunc(f.name, f.schema, f.typeSig, f.args)">
                    <div
                      v-for="(p, i) in paramRows(f.args, f.returns)"
                      :key="'p-' + i"
                      class="node child typed-row"
                      :title="p.rest ? `${p.name} ${p.rest}` : p.name"
                      @contextmenu="openNodeMenu($event, browserNode('function-parameter', `f-${f.oid}-param-${i}`, []))"
                    >
                      <span class="param-icon" :class="p.kind"><component :is="PARAM_ICONS[p.kind]" :size="14" /></span>
                      <span class="obj-name" v-html="highlightText(p.name)" />
                      <span class="node-badges"></span>
                      <span v-if="p.rest" class="dim" v-html="highlightText(p.rest)" />
                    </div>
                  </template>
                </div>
              </div>
            </template>
          </template>
          <div v-if="!filteredFunctions.length" class="empty">No functions</div>
        </template>
      </section>

      <div v-if="isFiltering && !totalMatches" class="empty no-match">
        No objects match “{{ filter }}”
      </div>

        <div
          v-if="contextMenu"
          class="browser-node-menu"
          :style="{ left: contextMenu.x + 'px', top: contextMenu.y + 'px' }"
          @click.stop
        >
          <button @click="collapseContextNode">Collapse</button>
        </div>
      </template>
    </div>

    <section class="pinned-files">
      <h3><Pin :size="13" /> Pinned files <span class="count">{{ tabs.state.pinnedFiles.length }}</span></h3>
      <div
        v-for="pin in tabs.state.pinnedFiles"
        :key="pin.id"
        class="pinned-file"
        :title="`${pin.fileName} · double-click to open in a new tab`"
        @dblclick="openPinnedFile(pin.id)"
        @contextmenu="openPinnedMenu($event, pin.id)"
      >
        <span class="obj-icon"><FileText :size="14" /></span>
        <span class="obj-name">{{ pin.fileName }}</span>
      </div>
    </section>

    <div
      v-if="pinnedContextMenu"
      class="browser-node-menu"
      :style="{ left: pinnedContextMenu.x + 'px', top: pinnedContextMenu.y + 'px' }"
      @click.stop
    >
      <button @click="unpinContextFile">Unpin</button>
    </div>
  </div>
</template>
