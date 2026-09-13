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
  /** Diff identity: the original catalog column name, or `new:<n>` for rows the
   * user added in the editor. The emitted `name` may differ (rename). */
  id: string
  name: string
  type: string
  nullable: boolean
  /** SQL expression text (`nextval(...)`, `now()`), null when none. */
  defaultValue: string | null
  description: string | null
}

export interface TableEditColumnState extends TableEditColumnInput {
  /** Read-only display flags — always computed from the live catalog. */
  pk: boolean
  unique: boolean
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
  args: string
  returns: string
  typeSig: string
  kind: 'function' | 'procedure' | 'window' | 'trigger' | 'aggregate'
  oid: string
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
}

export interface CommandResult {
  kind: 'command'
  command: string
  rowCount: number
}

export interface DataResult {
  kind: 'data'
  columns: string[]
  columnTypes: string[]
  rows: unknown[][]
  rowCount: number
  truncated: boolean
  /** Rows were discarded after reaching the limit; no cursor can retrieve them. */
  limited?: boolean
  totalRowCount?: number
}

export type QueryResult = CommandResult | DataResult

export interface QueryResponse {
  results: QueryResult[]
  durationMs: number
}

export interface FetchMoreResponse {
  rows: unknown[][]
  rowCount: number
  truncated: boolean
}
