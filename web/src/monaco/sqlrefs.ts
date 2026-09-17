// Pure SQL reference helpers for the Monaco completion provider.
// Dependency-free (no monaco / vue imports) so the parsing logic can be
// unit-tested in plain Node.

import { resolveQueryScope } from './sqlscope'

export interface RelRef {
  schema: string
  name: string
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

/** Quote an identifier for insert text only when required. */
export function quoteIdent(name: string): string {
  if (/^[a-z_][a-z0-9_]*$/.test(name)) return name
  return `"${name.replace(/"/g, '""')}"`
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
