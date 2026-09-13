// Type parsing/rebuilding for the table editor's base + length + scale
// controls. Kept pure and out of the component so the number-input coercion
// (v-model on type="number" yields a number, not a string) is unit-tested.

/** Bases whose DDL carries a parenthesized size after the drop-down. */
export const SIZE_BASES = new Set(['varchar', 'char', 'numeric'])

const SIZED_TYPE_RE =
  /^(character varying|varchar|char|character|numeric|decimal)\s*\(\s*(\d+)\s*(?:,\s*(\d+))?\s*\)$/i

/** Catalog spellings folded onto the drop-down's base names. */
const TYPE_ALIASES: Record<string, string> = {
  'character varying': 'varchar',
  character: 'char',
  decimal: 'numeric',
}

export interface ParsedColumnType {
  base: string
  len: string
  scale: string
}

/** Split a catalog type (`character varying(50)`, `numeric(10,2)`) into the
 * drop-down base and its size inputs. Anything else is kept verbatim. */
export function parseColumnType(type: string): ParsedColumnType {
  const m = SIZED_TYPE_RE.exec(type.trim())
  if (!m) return { base: type.trim(), len: '', scale: '' }
  const base = TYPE_ALIASES[m[1].toLowerCase()] ?? m[1].toLowerCase()
  return { base, len: m[2], scale: m[3] ?? '' }
}

/**
 * Rebuild the authoritative `type` string from base + length + scale. `len` and
 * `scale` are deliberately `unknown`: a `type="number"` input hands the model a
 * number, and calling `.trim()` on it would throw before the type is rebuilt.
 * Only called on user interaction, so an untouched row keeps the catalog's
 * exact spelling and the server diff never sees a phantom type change.
 */
export function buildColumnType(base: string, len: unknown, scale: unknown): string {
  if (!SIZE_BASES.has(base)) return base
  const length = String(len ?? '').trim()
  if (!length) return base
  if (base === 'numeric') {
    // PostgreSQL renders every numeric typmod as (precision,scale), including
    // scale 0 (`numeric(10,0)`, never `numeric(10)`), so default a cleared
    // scale to 0 and keep the emitted text canonical.
    const scaleText = String(scale ?? '').trim() || '0'
    return `numeric(${length},${scaleText})`
  }
  return `${base}(${length})`
}
