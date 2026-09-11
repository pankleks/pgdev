import { groupNamedObjects } from './objectgroups'
import type { TableInfo } from '../types'

export interface TableEntry {
  kind: 'group' | 'table'
  key: string
  schema: string
  name: string
  tables: TableInfo[]
}

export function groupTables(tables: TableInfo[], enabled: boolean): TableEntry[] {
  return groupNamedObjects(tables, enabled, 'table').map((entry) => ({
    kind: entry.kind === 'group' ? 'group' : 'table',
    key: entry.key,
    schema: entry.schema,
    name: entry.name,
    tables: entry.objects,
  }))
}
