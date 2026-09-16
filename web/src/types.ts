// The JSON contract lives on the server (schema-types.ts) so a field change
// breaks compilation on both sides. This module keeps the existing
// `from '../types'` imports working; types only — nothing here survives the
// vite build.
export type {
  AiActiveResult,
  AiConfig,
  AiLimits,
  AiResultGrid,
  AiResultMessage,
  AiTabInfo,
  AiTabList,
  ColumnInfo,
  CommandResult,
  ConnectionConfig,
  ConstraintInfo,
  DataResult,
  EditableGrid,
  EditableGridColumn,
  FetchMoreResponse,
  FunctionInfo,
  IndexInfo,
  QueryResponse,
  QueryResult,
   RowUpdateRequest,
   RowUpdateResponse,
   SchemaData,
   SequenceInfo,
   TableEditColumnInput,
  TableEditColumnState,
  TableEditKeyRef,
  TableEditRequest,
  TableEditResponse,
  TableEditState,
  TableInfo,
  TriggerInfo,
  TransactionState,
  TypeInfo,
  ViewInfo,
} from '../../server/src/schema-types'

// Values shared with the server (defaults and ranges the Settings dialog needs).
export { AI_LIMIT_RANGES, DEFAULT_AI_LIMITS } from '../../server/src/schema-types'
