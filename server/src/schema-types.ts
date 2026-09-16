// Transport types shared between the server routes and the browser.
//
// This is the single source of truth for the JSON contract: a field renamed
// here breaks compilation on both sides instead of silently diverging.
// Database-row shapes and Vue-only state stay local to their modules.

export interface ConnectionConfig {
  connectionString?: string
  host?: string
  port?: number
  database?: string
  user?: string
  password?: string
  ssl?: boolean
  /** Statement timeout in seconds applied to every query on the pool
   * (PostgreSQL `statement_timeout`). Server default: 30. */
  statementTimeout?: number
}

export interface ColumnInfo {
  name: string
  type: string
  nullable: boolean
  defaultValue: string | null
}

export interface IndexInfo {
  name: string
  type: 'primary' | 'unique' | 'exclusion' | 'normal'
  method: string
}

export interface ConstraintInfo {
  name: string
  type: string
  definition: string
}

export interface TriggerInfo {
  name: string
  definition: string
}

export interface TableInfo {
  schema: string
  name: string
  oid: string
  columns: ColumnInfo[]
  indexes: IndexInfo[]
  constraints: ConstraintInfo[]
  triggers: TriggerInfo[]
  isPartition: boolean
  isPartitioned: boolean
  parents: string
  /** pg_class.relkind: 'r' ordinary, 'p' partitioned parent, 'f' foreign. */
  relkind: 'r' | 'p' | 'f'
}

export interface TableEditColumnInput {
  /** Row identity for diffing: the catalog attnum as a string for existing
   * columns, or an editor-generated token for rows the user added. Never a
   * column name — a table may contain a column literally named `new:1`. */
  id: string
  /** True only for rows the user just added in the editor. Existing rows omit
   * it; added rows must not reuse a live column's identity. */
  added?: boolean
  name: string
  type: string
  nullable: boolean
  /** SQL expression text (`nextval(...)`, `now()`), null when none. */
  defaultValue: string | null
  description: string | null
}

export interface TableEditKeyRef {
  /** Running number per constraint/index in catalog order: "FK1", "UK2", …
   * Every column of one constraint or index shares the same number. */
  label: string
  /** The constraint or index name, e.g. `bom_product_fkey`. */
  name: string
  /** pg_get_constraintdef / pg_get_indexdef output for the tooltip. */
  definition: string
}

export interface TableEditColumnState extends TableEditColumnInput {
  /** Read-only display flags — always computed from the live catalog. */
  pk: boolean
  /** Outgoing foreign keys this column belongs to (display-only badge). */
  fks?: TableEditKeyRef[]
  /** Unique keys (constraints and standalone unique indexes) this column
   * belongs to (display-only badge). */
  uks?: TableEditKeyRef[]
  /** Identity/generated/serial columns: type, default (and usually nullable)
   * are locked; only description (and renames) remain editable. */
  locked: boolean
  lockKind?: 'identity' | 'generated' | 'serial'
}

export interface TableEditState {
  oid: string
  schema: string
  name: string
  /** Only ordinary tables (`'r'`) and partitioned parents (`'p'`) are editable. */
  relkind: 'r' | 'p'
  description: string | null
  columns: TableEditColumnState[]
  /** Hash of the live catalog state at read time. The dialog echoes it back on
   * submit, so a table changed in between is rejected rather than diffed
   * against a stale column set (which would turn a concurrent ADD COLUMN into
   * a DROP). */
  fingerprint: string
}

export interface TableEditRequest {
  description: string | null
  /** The `fingerprint` returned by the read endpoint. */
  fingerprint: string
  columns: TableEditColumnInput[]
}

export interface TableEditResponse {
  /** Change-only ALTER script, or null when nothing differs. */
  ddl: string | null
}

export interface ViewInfo {
  schema: string
  name: string
  oid: string
  materialized: boolean
  columns: ColumnInfo[]
}

export interface FunctionInfo {
  schema: string
  name: string
  /** Identity arguments (`pg_get_function_identity_arguments`), used for DDL. */
  args: string
  returns: string
  typeSig: string
  kind: 'function' | 'procedure' | 'window' | 'trigger' | 'aggregate'
  oid: string
  /** Full arguments with names, modes and defaults
   * (`pg_get_function_arguments`); user functions only. */
  arguments?: string
  /** `COMMENT ON FUNCTION/PROCEDURE` text, or null when none. */
  comment?: string | null
}

export interface TypeInfo {
  schema: string
  name: string
  oid: string
  kind: 'enum' | 'composite' | 'domain' | 'range'
  detail: string
}

export interface SequenceInfo {
  schema: string
  name: string
  oid: string
  /** format_type output of the underlying integer type. */
  dataType: string
  /** Rendered summary: increment, bounds, cache, cycle, ownership. */
  detail: string
}

export interface SchemaData {
  tables: TableInfo[]
  views: ViewInfo[]
  functions: FunctionInfo[]
  types: TypeInfo[]
  sequences: SequenceInfo[]
  /** Built-in pg_catalog functions for completion only: internal helpers are
   * filtered out, and the object browser never lists them. */
  builtins?: FunctionInfo[]
}

export interface CommandResult {
  kind: 'command'
  command: string
  rowCount: number
}

export interface EditableGridColumn {
  /** Result column name — a real table column present exactly once. */
  name: string
  pk: boolean
  generated: boolean
  /** False for NOT NULL columns: the row editor must not offer a NULL checkbox. */
  nullable: boolean
}

/** Row-editing metadata attached to a data result when its statement is a
 * plain single-table SELECT whose rows are uniquely identified by the full
 * primary key. */
export interface EditableGrid {
  schema: string
  table: string
  pk: string[]
  columns: EditableGridColumn[]
}

export interface DataResult {
  kind: 'data'
  columns: string[]
  columnTypes: string[]
  /** Declared character length per column (varchar(n)/char(n)), else null. */
  columnTypeLengths?: (number | null)[]
  rows: unknown[][]
  rowCount: number
  truncated: boolean
  /** Rows were discarded after reaching the limit; no cursor can retrieve them. */
  limited?: boolean
  totalRowCount?: number
  /** Present only when this result's rows can be edited in place. */
  editable?: EditableGrid
}

export type QueryResult = CommandResult | DataResult

export interface TransactionState {
  transactionOpen: boolean
  /** Identity of the pinned manual-transaction session; null when none exists. */
  transactionId: string | null
}

/** One row UPDATE built by the row editor: key = full primary key values,
 * set = changed column values (JSON null means SQL NULL). */
export interface RowUpdateRequest {
  tabKey: string
  /** Expected transaction session; null explicitly requires no manual transaction. */
  transactionId?: string | null
  schema: string
  table: string
  key: Record<string, unknown>
  set: Record<string, unknown | null>
}

export interface RowUpdateResponse extends TransactionState {
  /** The stored row (UPDATE … RETURNING *), keyed by column name with the
   * same value transport as grid cells. */
  row: Record<string, unknown>
}

export interface QueryResponse extends TransactionState {
  results: QueryResult[]
  durationMs: number
}

export interface FetchMoreResponse {
  rows: unknown[][]
  rowCount: number
  truncated: boolean
}

/** Everything an MCP client needs to reach this pgDEV instance. */
export interface AiConfig {
  url: string
  token: string
  /** Absolute path to bin/pgdev-mcp.mjs. */
  command: string
  /** Ready-to-paste client configuration JSON. */
  config: string
  /** Limits currently applied to every result set the agent reads. */
  limits: AiLimits
}

/** How much of a result set the agent may see (Settings → AI agent). */
export interface AiLimits {
  /** Rows per result set. */
  maxRows: number
  /** Bytes of row JSON per result set. */
  maxBytes: number
}

/** Accepted range for the configurable AI limits; shared by the Settings
 * dialog, the endpoints that validate them, and the MCP surface. */
export const AI_LIMIT_RANGES = {
  maxRows: { min: 1, max: 10000 },
  maxBytes: { min: 1024, max: 4 * 1024 * 1024 },
} as const

/** What the agent sees when nothing has been configured. */
export const DEFAULT_AI_LIMITS: AiLimits = { maxRows: 100, maxBytes: 64 * 1024 }

/** One line of a result panel's Messages tab. */
export interface AiResultMessage {
  level: 'info' | 'error'
  text: string
}

/** One result set of the active tab, as it currently sits in the grid. */
export interface AiResultGrid {
  /** 1-based position in the batch. */
  statement: number
  columns: string[]
  columnTypes: string[]
  rows: unknown[][]
  rowCount: number
  /** The agent's limit (or the grid's own) cut rows off. */
  truncated: boolean
  /** Rows were discarded at the server row limit; no cursor can fetch them. */
  limited: boolean
  /** Rows the statement would have returned, when the row limit was reached. */
  totalRowCount?: number
  /** Rows an export streamed to a file, when that consumed the cursor. */
  exported?: number
}

/** What the active tab last produced on screen (`get_active_result`). */
export interface AiActiveResult {
  tab: { key: string; title: string; readOnly: boolean }
  /** False when nothing has been run in the tab yet. */
  ran: boolean
  /** A statement (or page load) is in flight right now. */
  running: boolean
  /** A user-managed transaction is open for the tab. */
  transactionOpen: boolean
  /** Statement number the grid shows; null while Messages is shown. */
  selected: number | null
  messages: AiResultMessage[]
  results: AiResultGrid[]
}

/** One tab the agent opened, as `list_tabs` reports it. */
export interface AiTabInfo {
  key: string
  title: string
  /** 'query' | 'ddl' — agent tabs are always query tabs. */
  kind: string
  readOnly: boolean
  /** True when the content differs from what was staged (only you can close it). */
  dirty: boolean
  /** True when this is the tab the editor shows. */
  active: boolean
}

/** The agent's own tabs (`list_tabs`). User tabs are never listed. */
export interface AiTabList {
  activeKey: string | null
  tabs: AiTabInfo[]
}
