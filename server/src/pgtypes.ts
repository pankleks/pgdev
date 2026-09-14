import { types } from 'pg'

// JSON/JSONB, temporal and (for simple editing) boolean/integer/text arrays
// must reach the browser as raw server text. The driver's built-in parsers
// JSON.parse JSON (losing precision on large integers, rewriting number
// spellings, turning a JSON string scalar into a bare string
// indistinguishable from SQL NULL) and turn date/time values into JS Dates,
// which serialize back to ISO UTC text and shift wall-clock values.
// PostgreSQL already emits canonical text, so an identity parser is
// lossless, cheaper, and keeps cells exactly round-trippable for the row
// editor.
const RAW_TYPE_IDS = new Set([
  114 /* json */, 3802 /* jsonb */,
  1082 /* date */, 1083 /* time */, 1114 /* timestamp */, 1184 /* timestamptz */, 1266 /* timetz */,
  1182 /* date[] */, 1183 /* time[] */, 1115 /* timestamp[] */, 1185 /* timestamptz[] */, 1270 /* timetz[] */,
  // Integer, boolean and text/varchar arrays: the row editor edits them as
  // single-line PostgreSQL literals (`{10, 20}`, `{TRUE,FALSE}`), which only
  // works if the driver does not turn them into JSON-looking JS arrays first.
  1000 /* bool[] */, 1005 /* int2[] */, 1007 /* int4[] */, 1016 /* int8[] */,
  1009 /* text[] */, 1014 /* bpchar[] */, 1015 /* varchar[] */,
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
