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

/** Lower-cased comparison form (unquoted PG identifiers fold to lower). */
export function normIdent(id: string): string {
  return unquoteIdent(id).toLowerCase()
}

/** Quote an identifier for insert text only when required. */
export function quoteIdent(name: string): string {
  if (/^[a-z_][a-z0-9_]*$/.test(name)) return name
  return `"${name.replace(/"/g, '""')}"`
}

/**
 * Split a dotted chain (`sch."My Table".col`) into its parts,
 * keeping quoted segments intact.
 */
export function splitChain(chain: string): string[] {
  const parts: string[] = []
  const re = /"[^"]*"|[A-Za-z_][A-Za-z0-9_]*/g
  let m: RegExpExecArray | null
  while ((m = re.exec(chain)) !== null) parts.push(m[0])
  return parts
}

/** Trailing dotted qualifier before the cursor, e.g. `f.` or `sch.tbl.`. */
export function matchDotChain(lineBefore: string): string | null {
  const m =
    /((?:"[^"]*"|[A-Za-z_][A-Za-z0-9_]*)(?:\s*\.\s*(?:"[^"]*"|[A-Za-z_][A-Za-z0-9_]*))*)\.\s*$/.exec(
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
  /(?:FROM|JOIN)\s+((?:"[^"]*"|[A-Za-z_][A-Za-z0-9_]*)(?:\s*\.\s*(?:"[^"]*"|[A-Za-z_][A-Za-z0-9_]*))?)(?:\s+(?:AS\s+)?((?:"[^"]*"|[A-Za-z_][A-Za-z0-9_]*)))?/gi

/**
 * Map lowercase alias (or bare table name used as self-reference) to the
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
    // Bare table name always resolves to itself (unless schema-qualified).
    if (!target.schema) aliases.set(target.name, target)
    const rawAlias = m[2]
    if (rawAlias && !NON_ALIAS.has(unquoteIdent(rawAlias).toUpperCase())) {
      aliases.set(normIdent(rawAlias), target)
    }
  }
  return aliases
}
