// Formatting for the results-grid value dialog: JSON/JSONB columns are
// pretty-printed, everything else shows verbatim. Pure and unit-tested.

const JSON_TYPES = new Set(['json', 'jsonb'])

/**
 * Format one result cell for display in the value dialog. JSON/JSONB values
 * arrive as JSON text (the server stringifies them for transport), so a
 * successful parse is reprinted with a two-space indent; anything that does
 * not parse — a JSON scalar path can still fail, and non-JSON types — shows
 * the raw text unchanged.
 */
export function formatCellValue(value: string, type: string): string {
  if (!JSON_TYPES.has(type) || typeof value !== 'string' || !value.trim()) return value
  try {
    return JSON.stringify(JSON.parse(value), null, 2)
  } catch {
    return value
  }
}
