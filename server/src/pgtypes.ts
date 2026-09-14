import { types } from 'pg'

// JSON and JSONB must reach the browser as raw server text. The driver's
// built-in parsers JSON.parse them, which loses precision on large integers,
// rewrites number spellings (`1.0` becomes `1`), and turns a JSON string
// scalar ('"abc"') into a bare string indistinguishable from SQL NULL.
// PostgreSQL already emits canonical text, so an identity parser is lossless
// (and cheaper than parse-then-stringify).
const JSON_TYPE_IDS = new Set([114 /* json */, 3802 /* jsonb */])

/**
 * Custom type config for query calls that return user data: JSON/JSONB stay
 * text, every other type keeps the driver's default parser. Passed per query
 * (never registered globally) so catalog and DDL reads are unaffected.
 */
export const rawJsonTypes = {
  getTypeParser(oid: number, format?: 'text' | 'binary') {
    if (JSON_TYPE_IDS.has(oid)) return (value: string) => value
    return types.getTypeParser(oid, format)
  },
}
