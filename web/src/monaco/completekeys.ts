import type { FunctionInfo } from '../types'

// Pure predicates behind the SQL completion provider (completions.ts): the
// provider itself needs Monaco and the schema store, but the ranking rules —
// which suggestions survive, which stay distinct, when built-ins appear —
// are plain string logic and are unit-tested directly.

/** Built-ins run into the thousands: only offer them once typed this far. */
export const MIN_BUILTIN_PREFIX = 2

export function builtinActive(prefix: string): boolean {
  return prefix.length >= MIN_BUILTIN_PREFIX
}

/**
 * The same rule Monaco fuzzy-filters with: every prefix character must appear
 * in the label in order (case ignored); an empty prefix passes everything.
 * Candidates that could never pass are pure per-keystroke cost.
 */
export function completionMatchesPrefix(prefix: string, label: string): boolean {
  if (!prefix) return true
  let at = 0
  const hay = label.toLowerCase()
  const needle = prefix.toLowerCase()
  for (const ch of needle) {
    at = hay.indexOf(ch, at)
    if (at === -1) return false
    at++
  }
  return true
}

/** Signature line for a function-like object; procedures have no result. */
export function functionDetail(f: FunctionInfo): string {
  // public and pg_catalog objects are callable unqualified; a non-public
  // schema is named so same-named functions stay distinguishable.
  const schema = f.schema === 'public' || f.schema === 'pg_catalog' ? '' : ` · ${f.schema}`
  if (f.kind === 'procedure') return `(${f.args}) · procedure${schema}`
  const returns = f.returns ? ` → ${f.returns}` : ''
  const suffix = f.kind === 'aggregate' ? ' · aggregate' : f.kind === 'window' ? ' · window' : ''
  return `(${f.args})${returns}${suffix}${schema}`
}

/**
 * Dedup keys: relations and types are keyed by kind and schema as well as
 * name, so `public.orders` and `sales.orders` both stay suggested instead of
 * one silently replacing the other.
 */
export function objectKey(kind: string, schema: string, name: string): string {
  return `${kind}\u0000${schema}\u0000${name}`
}

/**
 * Functions pass a composite key: overloads and same-named functions in
 * other schemas (or a function sharing a column's name) are distinct
 * suggestions, not duplicates.
 */
export function functionSuggestionKey(name: string, qualifiedName: string, detail: string): string {
  return `${name}\u0000${qualifiedName}\u0000${detail}`
}
