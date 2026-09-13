// The JSON contract lives on the server (schema-types.ts) so a field change
// breaks compilation on both sides. This module keeps the existing
// `from '../types'` imports working; types only — nothing here survives the
// vite build.
export type {
  ColumnInfo,
  CommandResult,
  ConnectionConfig,
  ConstraintInfo,
  DataResult,
  FetchMoreResponse,
  FunctionInfo,
  IndexInfo,
  QueryResponse,
  QueryResult,
  SchemaData,
  TableEditColumnInput,
  TableEditColumnState,
  TableEditRequest,
  TableEditResponse,
  TableEditState,
  TableInfo,
  TriggerInfo,
  TypeInfo,
  ViewInfo,
} from '../../server/src/schema-types'
