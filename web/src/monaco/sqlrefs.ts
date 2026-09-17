// Pure SQL reference helpers for the Monaco completion provider.
// Dependency-free (no monaco / vue imports) so the parsing logic can be
// unit-tested in plain Node.

import type { ColumnInfo } from '../types'
import { resolveQueryScope } from './sqlscope'

export interface RelRef {
  schema: string
  name: string
  /** Output columns inferred for a CTE or derived table; absent for catalog refs. */
  columns?: ColumnInfo[]
  /** Display label for a synthetic (CTE/derived) relation. */
  label?: string
}

/**
 * Label for detail lines: a synthetic CTE/derived relation carries its own
 * label; a public catalog relation stays unqualified.
 */
export function relationLabel(r: { schema: string; name: string; label?: string }): string {
  if (r.label) return r.label
  return r.schema === 'public' ? r.name : `${r.schema}.${r.name}`
}

/** Remove surrounding double quotes and unescape `""`. */
export function unquoteIdent(id: string): string {
  const t = id.trim()
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    return t.slice(1, -1).replace(/""/g, '"')
  }
  return t
}

/** Fold unquoted identifiers only; quoted PostgreSQL names are case-sensitive. */
export function normIdent(id: string): string {
  const trimmed = id.trim()
  return trimmed.startsWith('"') && trimmed.endsWith('"')
    ? unquoteIdent(trimmed)
    : trimmed.toLowerCase()
}

/** Resolve normalized references against the exact names from pg_catalog. */
export function findRelation<T extends { schema: string; name: string }>(
  relations: T[],
  ref: RelRef,
): T | undefined {
  if (ref.schema) return relations.find((r) => r.schema === ref.schema && r.name === ref.name)
  const matches = relations.filter((r) => r.name === ref.name)
  // Completion metadata does not contain search_path. Prefer public, then a
  // unique match; never guess among several non-public schemas.
  return matches.find((r) => r.schema === 'public') ?? (matches.length === 1 ? matches[0] : undefined)
}

export function resolveQualifier<T extends { schema: string; name: string }>(
  relations: T[],
  parts: string[],
  aliases: Map<string, RelRef>,
): T | undefined {
  if (!parts.length) return undefined
  const name = normIdent(parts[parts.length - 1])
  if (parts.length > 1) {
    return findRelation(relations, { schema: normIdent(parts[parts.length - 2]), name })
  }
  // A known alias owns its qualifier even when its target is missing. Falling
  // back to a same-named table would offer columns from an unrelated relation.
  const ref = aliases.get(name)
  if (ref) return findRelation(relations, ref)
  // Once a query declares sources, a bare table outside that namespace is not
  // a usable qualifier. Keep catalog discovery for a statement with no FROM.
  return aliases.size ? undefined : findRelation(relations, { schema: '', name })
}

// PostgreSQL reserved words (Appendix C, category "reserved"). A name that is
// otherwise a valid unquoted identifier still has to be quoted when it is one
// of these, or the inserted SQL would be a syntax error.
const RESERVED = new Set(
  ('ALL ANALYSE ANALYZE AND ANY ARRAY AS ASC ASYMMETRIC BOTH CASE CAST CHECK COLLATE COLUMN CONSTRAINT ' +
    'CREATE CURRENT_CATALOG CURRENT_DATE CURRENT_ROLE CURRENT_TIME CURRENT_TIMESTAMP CURRENT_USER DEFAULT ' +
    'DEFERRABLE DESC DISTINCT DO ELSE END EXCEPT FALSE FETCH FOR FOREIGN FROM GRANT GROUP HAVING IN ' +
    'INITIALLY INTERSECT INTO LATERAL LEADING LIMIT LOCALTIME LOCALTIMESTAMP NOT NULL OFFSET ON ONLY OR ' +
    'ORDER PLACING PRIMARY REFERENCES RETURNING SELECT SESSION_USER SOME SYMMETRIC TABLE THEN TO TRAILING ' +
    'TRUE UNION UNIQUE USER USING VARIADIC WHEN WHERE WINDOW WITH')
    .split(' '),
)

/** Quote an identifier for insert text only when required. */
export function quoteIdent(name: string): string {
  if (/^[a-z_][a-z0-9_]*$/.test(name) && !RESERVED.has(name.toUpperCase())) return name
  return `"${name.replace(/"/g, '""')}"`
}

/**
 * Escape text that will be placed inside a Monaco snippet (function call
 * insert text). A literal `$`, `}` or `\` would otherwise be read as snippet
 * syntax, so an object named `a$b` must not turn into a snippet variable.
 */
export function escapeSnippet(text: string): string {
  return text.replace(/[\\$}]/g, '\\$&')
}

/**
 * Resolve a dotted-chain part to a loaded schema spelling, or null. Unquoted
 * parts fold to lower case per PostgreSQL; quoted parts match exactly.
 */
export function findSchema(schemas: readonly string[], part: string): string | null {
  const name = normIdent(part)
  return schemas.includes(name) ? name : null
}

/**
 * Split a dotted chain (`sch."My Table".col`) into its parts,
 * keeping quoted segments intact.
 */
export function splitChain(chain: string): string[] {
  const parts: string[] = []
  const re = /"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_]*/g
  let m: RegExpExecArray | null
  while ((m = re.exec(chain)) !== null) parts.push(m[0])
  return parts
}

/** Trailing dotted qualifier before the cursor, e.g. `f.` or `sch.tbl.`. */
export function matchDotChain(lineBefore: string): string | null {
  const m =
    /((?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_]*)(?:\s*\.\s*(?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_]*))*)\.\s*$/.exec(
      lineBefore,
    )
  return m ? m[1] : null
}

/** Relation bindings at the cursor; defaults to the end for standalone callers. */
export function parseAliases(sql: string, offset = sql.length): Map<string, RelRef> {
  return resolveQueryScope(sql, offset).aliases
}
