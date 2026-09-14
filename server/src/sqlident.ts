/**
 * Quote a PostgreSQL identifier (schema, table, column, cursor name) for
 * interpolation into SQL text. Values are never handled here — they are
 * always sent as query parameters.
 */
export function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}
