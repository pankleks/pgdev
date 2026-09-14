import { formatCellValue } from './cellvalue'

// Type-to-editor mapping for the row dialog. Pure functions only, so the
// mapping and the value conversions are unit-testable without a DOM.

export type EditorKind = 'boolean' | 'number' | 'date' | 'time' | 'datetime' | 'json' | 'text'

const NUMBER_TYPES = new Set([
  'smallint',
  'integer',
  'bigint',
  'numeric',
  'real',
  'double precision',
])
const INTEGER_TYPES = new Set(['smallint', 'integer', 'bigint'])

/** Types the row editor refuses to write back (the transport is a summary,
 * e.g. `<bytea 12 bytes>`, so saving it would corrupt the column). */
const READ_ONLY_TYPES = new Set(['bytea'])

/** Strip a parenthesized modifier (`numeric(10,2)`) and normalise case. */
export function baseType(type: string): string {
  return type.replace(/\(.*\)$/, '').trim().toLowerCase()
}

export function editorKind(type: string): EditorKind {
  const base = baseType(type)
  if (base === 'boolean') return 'boolean'
  if (NUMBER_TYPES.has(base)) return 'number'
  if (base === 'date') return 'date'
  if (base === 'time without time zone') return 'time'
  if (base === 'timestamp without time zone' || base === 'timestamp with time zone') return 'datetime'
  if (base === 'json' || base === 'jsonb') return 'json'
  return 'text'
}

export function isReadOnlyType(type: string): boolean {
  return READ_ONLY_TYPES.has(baseType(type))
}

/** Only `text` and JSON/JSONB get a multi-line control; `varchar(n)`, `char`,
 * uuid, enums and everything else use a single-line text input. */
export function usesTextarea(type: string): boolean {
  return editorKind(type) === 'json' || baseType(type) === 'text'
}

/** `step` for the numeric input: whole numbers vs arbitrary precision. */
export function numberStep(type: string): '1' | 'any' {
  return INTEGER_TYPES.has(baseType(type)) ? '1' : 'any'
}

/** Whether a row value means boolean true (driver booleans and text alike). */
export function toBool(raw: unknown): boolean {
  return raw === true || raw === 'true'
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0')
}

function localDateTime(d: Date): string {
  const base =
    `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  const ms = d.getMilliseconds()
  return ms ? `${base}.${pad(ms, 3)}` : base
}

/**
 * Native time controls only accept up to milliseconds; PostgreSQL prints
 * microseconds. More digits make the value invalid (the control renders
 * empty), so the fraction is truncated here. An untouched field is never
 * written back, so the stored value keeps its full precision.
 */
function truncateFraction(value: string): string {
  const match = /^(.*?\.\d{1,3})\d*$/.exec(value)
  return match ? (match[1] as string) : value
}

/** PostgreSQL may print `+00` where ISO requires `+00:00`. */
function offsetNormalized(raw: string): string {
  const s = raw.trim().replace(' ', 'T')
  return /[+-]\d{2}$/.test(s) ? `${s}:00` : s
}

function isTimestamptz(type: string): boolean {
  return baseType(type) === 'timestamp with time zone'
}

/**
 * PostgreSQL text → value for the matching native control.
 * - json/jsonb: pretty-printed (the textarea edits the same token-safe text)
 * - timestamp without time zone: space separator becomes `T`
 * - timestamp with time zone: converted to the browser's wall clock, since a
 *   `datetime-local` control cannot carry an offset
 * - time: used as-is
 * Sub-second digits beyond milliseconds are truncated for `time` and
 * timestamp controls (see truncateFraction). Everything else passes through
 * unchanged; unparsable input is handed back untouched (the control shows
 * empty, the field stays clean until edited).
 */
export function toEditorValue(raw: string, type: string): string {
  const kind = editorKind(type)
  if (kind === 'json') return formatCellValue(raw, type)
  if (kind === 'datetime') {
    if (isTimestamptz(type)) {
      const parsed = new Date(offsetNormalized(raw))
      if (!Number.isNaN(parsed.getTime())) return localDateTime(parsed)
    }
    return truncateFraction(raw.trim().replace(' ', 'T'))
  }
  if (kind === 'time') return truncateFraction(raw.trim())
  return raw
}

/**
 * Control value → the parameter sent to PostgreSQL. Native controls emit
 * values PostgreSQL accepts directly (`2024-01-15T10:30:00` for timestamps,
 * `10:30:00` for times, `2024-01-15` for dates), so this is the identity;
 * it exists to keep the round-trip explicit and testable.
 */
export function fromEditorValue(control: string): string {
  return control
}

/**
 * Syntax-check edited JSON/JSONB text before it is sent. Returns a message
 * when the text does not parse, else null. Only the check uses the parsed
 * value — the token-preserving textarea text is what gets saved, so number
 * spellings and large integers are never rewritten.
 */
export function jsonSyntaxError(text: string): string | null {
  try {
    JSON.parse(text)
    return null
  } catch (e) {
    return (e as Error).message
  }
}
