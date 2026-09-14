import { types } from 'pg'

// JSON/JSONB and temporal types must reach the browser as raw server text.
// The driver's built-in parsers JSON.parse JSON (losing precision on large
// integers, rewriting number spellings, turning a JSON string scalar into a
// bare string indistinguishable from SQL NULL) and turn date/time values into
// JS Dates, which serialize back to ISO UTC text and shift wall-clock values.
// PostgreSQL already emits canonical text, so an identity parser is lossless,
// cheaper, and keeps temporal cells exactly round-trippable for the row editor.
const RAW_TYPE_IDS = new Set([
  114 /* json */, 3802 /* jsonb */,
  1082 /* date */, 1083 /* time */, 1114 /* timestamp */, 1184 /* timestamptz */, 1266 /* timetz */,
  1182 /* date[] */, 1183 /* time[] */, 1115 /* timestamp[] */, 1185 /* timestamptz[] */, 1270 /* timetz[] */,
])

/**
 * Custom type config for query calls that return user data: JSON/JSONB and
 * temporal types stay text, every other type keeps the driver's default
 * parser. Passed per query (never registered globally) so catalog and DDL
 * reads are unaffected.
 */
export const rawTextTypes = {
  getTypeParser(oid: number, format?: 'text' | 'binary') {
    if (RAW_TYPE_IDS.has(oid)) return (value: string) => value
    return types.getTypeParser(oid, format)
  },
}
