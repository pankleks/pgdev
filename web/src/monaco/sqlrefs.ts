// Pure SQL reference helpers for the Monaco completion provider.
// Dependency-free (no monaco / vue imports) so the parsing logic can be
// unit-tested in plain Node.

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
  return findRelation(relations, aliases.get(name) ?? { schema: '', name })
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

// Keywords that may follow a table reference — never treat them as aliases.
const NON_ALIAS = new Set(
  'SELECT FROM WHERE JOIN INNER LEFT RIGHT FULL OUTER CROSS ON AS AND OR NOT NULL IS IN BETWEEN LIKE ILIKE GROUP BY ORDER HAVING LIMIT OFFSET INSERT INTO VALUES UPDATE SET DELETE RETURNING CREATE TABLE VIEW MATERIALIZED INDEX DROP ALTER ADD COLUMN DISTINCT CASE WHEN THEN ELSE END UNION INTERSECT EXCEPT ALL EXISTS ASC DESC WITH OVER PARTITION WINDOW FILTER FETCH FOR NATURAL USING TRUE FALSE PRIMARY KEY FOREIGN REFERENCES CHECK DEFAULT CONSTRAINT UNIQUE CASCADE GRANT COMMENT ANALYZE EXPLAIN TRUNCATE BEGIN COMMIT ROLLBACK'
    .split(' ')
    .map((w) => w.toUpperCase()),
)

const FROM_JOIN_RE =
  /(?:FROM|JOIN)\s+((?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_]*)(?:\s*\.\s*(?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_]*))?)(?:\s+(?:AS\s+)?((?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_]*)))?/gi

/**
 * Map normalized alias (or bare table name used as self-reference) to the
 * referenced relation. `SELECT … FROM sch.tbl t JOIN foo …` yields
 * `t → sch.tbl`, `tbl → sch.tbl`, `foo → foo`.
 */
export function parseAliases(sql: string): Map<string, RelRef> {
  const aliases = new Map<string, RelRef>()
  // Bound the work on very large documents.
  const text = sql.length > 8000 ? sql.slice(sql.length - 8000) : sql
  FROM_JOIN_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = FROM_JOIN_RE.exec(text)) !== null) {
    const targetParts = splitChain(m[1]).map(normIdent)
    if (!targetParts.length) continue
    const target: RelRef =
      targetParts.length > 1
        ? { schema: targetParts[targetParts.length - 2], name: targetParts[targetParts.length - 1] }
        : { schema: '', name: targetParts[0] }
    // A bare qualifier can refer to a schema-qualified FROM relation too.
    aliases.set(target.name, target)
    const rawAlias = m[2]
    if (rawAlias && (rawAlias.startsWith('"') || !NON_ALIAS.has(rawAlias.toUpperCase()))) {
      aliases.set(normIdent(rawAlias), target)
    }
  }
  return aliases
}
