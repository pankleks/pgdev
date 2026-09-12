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
