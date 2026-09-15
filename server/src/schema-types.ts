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

export interface SchemaData {
  tables: TableInfo[]
  views: ViewInfo[]
  functions: FunctionInfo[]
  types: TypeInfo[]
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

/** One row UPDATE built by the row editor: key = full primary key values,
 * set = changed column values (JSON null means SQL NULL). */
export interface RowUpdateRequest {
  tabKey: string
  schema: string
  table: string
  key: Record<string, unknown>
  set: Record<string, unknown | null>
}

export interface RowUpdateResponse {
  /** The stored row (UPDATE … RETURNING *), keyed by column name with the
   * same value transport as grid cells. */
  row: Record<string, unknown>
  /** True when the update ran inside the tab's open manual transaction. */
  transactionOpen: boolean
}

export interface QueryResponse {
  results: QueryResult[]
  durationMs: number
  /** True when the batch left a user-managed transaction open for this tab. */
  transactionOpen?: boolean
}

export interface FetchMoreResponse {
  rows: unknown[][]
  rowCount: number
  truncated: boolean
}
