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
  kind: 'function' | 'procedure' | 'window' | 'trigger'
  oid: string
}

export interface SchemaData {
  tables: TableInfo[]
  views: ViewInfo[]
  functions: FunctionInfo[]
}

export interface ConnectionConfig {
  connectionString?: string
  host?: string
  port?: number
  database?: string
  user?: string
  password?: string
  ssl?: boolean
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
}

export type QueryResult = CommandResult | DataResult

export interface QueryResponse {
  results: QueryResult[]
  durationMs: number
}
