import { ident } from './sqlident.js'
import type { RowEditInfo } from './catalog/rowedit.js'

// Pure planner for the row editor's UPDATE. The browser payload is never
// trusted: the key must be exactly the table's primary key, every SET target
// must be a real, writable column, and identifiers are quoted here. Values
// travel as parameters; JSON null means SQL NULL (a JSON/JSONB column's own
// `null` text is sent as the string "null" by the dialog).

export interface RowUpdateValues {
  key: Record<string, unknown>
  set: Record<string, unknown | null>
}

export type RowUpdateError =
  | { kind: 'no-key'; column: string }
  | { kind: 'key-mismatch'; expected: string[] }
  | { kind: 'no-values' }
  | { kind: 'unknown-column'; column: string }
  | { kind: 'locked-column'; column: string }
  | { kind: 'bad-value'; column: string }

export type RowUpdatePlan =
  | { kind: 'ok'; text: string; values: unknown[] }
  | { kind: 'error'; error: RowUpdateError }

function isValue(v: unknown): v is string | number | boolean {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
}

/**
 * Build the single UPDATE that stores one row's changes. `info` must be a
 * fresh live read of the table (fetchRowEditInfo) — never client metadata.
 */
export function planRowUpdate(values: RowUpdateValues, info: RowEditInfo): RowUpdatePlan {
  const keyNames = Object.keys(values.key)
  const pkSet = new Set(info.pk)
  if (keyNames.length !== info.pk.length || info.pk.some((c) => !keyNames.includes(c))) {
    return { kind: 'error', error: { kind: 'key-mismatch', expected: [...info.pk] } }
  }
  for (const col of info.pk) {
    const v = values.key[col]
    if (!isValue(v)) return { kind: 'error', error: { kind: 'no-key', column: col } }
  }

  const byName = new Map(info.columns.map((c) => [c.name, c]))
  const entries = Object.entries(values.set)
  if (!entries.length) return { kind: 'error', error: { kind: 'no-values' } }
  for (const [col, v] of entries) {
    const column = byName.get(col)
    if (!column) return { kind: 'error', error: { kind: 'unknown-column', column: col } }
    if (column.pk || column.generated || column.type === 'bytea') {
      return { kind: 'error', error: { kind: 'locked-column', column: col } }
    }
    if (v !== null && !isValue(v)) {
      return { kind: 'error', error: { kind: 'bad-value', column: col } }
    }
  }

  const params: unknown[] = entries.map(([, v]) => v)
  const assigns = entries.map(([col], i) => `${ident(col)} = $${i + 1}`)
  const wheres = info.pk.map((col, i) => {
    params.push(values.key[col])
    return `${ident(col)} = $${entries.length + i + 1}`
  })
  const text =
    `UPDATE ${ident(info.schema)}.${ident(info.name)} ` +
    `SET ${assigns.join(', ')} ` +
    `WHERE ${wheres.join(' AND ')} ` +
    `RETURNING *`
  return { kind: 'ok', text, values: params }
}
