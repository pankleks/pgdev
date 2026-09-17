// Cursor-aware relation scope shared by completion and hover. This is a
// tolerant scope parser, not a SQL validator: unfinished statements and open
// parentheses are normal editor input. CTEs and derived tables become
// synthetic relations whose output columns are inferred from their SELECT
// list, so `d.` can offer columns the catalog does not know about.
import { scanSqlLexemes, type SqlLexeme } from '../../../server/src/sqllex'
import type { ColumnInfo } from '../types'
import type { RelRef } from './sqlrefs'

interface Group {
  kind: 'group'
  delimiter: '(' | '[' | null
  start: number
  end: number
  items: Item[]
}
type Item = SqlLexeme | Group

/** A safe placeholder for an output column whose type cannot be inferred. */
const UNKNOWN_COLUMN = '?'
function column(name: string): ColumnInfo {
  return { name, type: UNKNOWN_COLUMN, nullable: true, defaultValue: null }
}

/** A relation that only exists in the query text: a CTE or derived table. */
export interface ScopeRelation {
  schema: string
  name: string
  /** Human label shown in detail lines (the CTE or alias name). */
  label: string
  columns: ColumnInfo[]
}

export interface QueryScope {
  aliases: Map<string, RelRef>
  /** Synthetic relations the aliases may point at. */
  relations: ScopeRelation[]
  /** A source exists even when its columns are not yet known. */
  hasRelations: boolean
}

const NON_ALIAS = new Set(
  ('SELECT FROM WHERE JOIN INNER LEFT RIGHT FULL OUTER CROSS ON AS AND OR NOT NULL IS IN BETWEEN LIKE ILIKE ' +
    'GROUP BY ORDER HAVING LIMIT OFFSET INSERT INTO VALUES UPDATE SET DELETE RETURNING CREATE TABLE VIEW ' +
    'MATERIALIZED INDEX DROP ALTER ADD COLUMN DISTINCT CASE WHEN THEN ELSE END UNION INTERSECT EXCEPT ALL ' +
    'EXISTS ASC DESC WITH OVER PARTITION WINDOW FILTER FETCH FOR NATURAL USING TRUE FALSE PRIMARY KEY ' +
    'FOREIGN REFERENCES CHECK DEFAULT CONSTRAINT UNIQUE CASCADE GRANT COMMENT ANALYZE EXPLAIN TRUNCATE ' +
    'BEGIN COMMIT ROLLBACK LATERAL ONLY TABLESAMPLE REPEATABLE RECURSIVE SEARCH CYCLE CONFLICT DO NOTHING ' +
    'EXCLUDED')
    .split(' '),
)
const FROM_END = new Set(['WHERE', 'GROUP', 'HAVING', 'WINDOW', 'ORDER', 'LIMIT', 'OFFSET', 'FETCH', 'FOR', 'RETURNING', 'SET'])
const SET_OPS = new Set(['UNION', 'INTERSECT', 'EXCEPT'])
const QUERY_START = new Set(['SELECT', 'WITH', 'VALUES', 'TABLE'])
const SELECT_LIST_END = new Set([
  'FROM', 'INTO', 'WHERE', 'GROUP', 'HAVING', 'WINDOW', 'ORDER', 'LIMIT', 'OFFSET', 'FETCH', 'FOR',
  'UNION', 'INTERSECT', 'EXCEPT',
])

function keyword(item: Item | undefined): string {
  return item?.kind === 'ident' && !item.quoted ? item.name.toUpperCase() : ''
}
function ident(item: Item | undefined): string | null {
  return item?.kind === 'ident' ? (item.quoted ? item.name : item.name.toLowerCase()) : null
}
function punct(item: Item | undefined, value: string): boolean {
  return item?.kind === 'punct' && item.raw === value
}
function aliasName(item: Item | undefined): string | null {
  return item?.kind === 'ident' && (item.quoted || !NON_ALIAS.has(keyword(item))) ? ident(item) : null
}
function fromClause(items: Item[], i: number): boolean {
  if (keyword(items[i]) !== 'FROM') return false
  // IS [NOT] DISTINCT FROM is an expression operator, not a source clause.
  return !(keyword(items[i - 1]) === 'DISTINCT' &&
    (keyword(items[i - 2]) === 'IS' ||
      (keyword(items[i - 2]) === 'NOT' && keyword(items[i - 3]) === 'IS')))
}
function unknown(): RelRef {
  // Empty names cannot identify a PostgreSQL relation.
  return { schema: '', name: '' }
}
function syntheticFrom(label: string, group: Group, columns: ColumnInfo[]): { ref: RelRef; relation: ScopeRelation } {
  // A NUL prefix cannot occur in a PostgreSQL identifier, so a synthetic ref
  // never matches a catalog relation that happens to share the name.
  const name = `\u0000${group.start}:${label}`
  return {
    ref: { schema: '', name, columns, label },
    relation: { schema: '', name, label, columns },
  }
}

/** Keep the complete statement around the cursor, including its later FROM. */
function statement(text: string, offset: number): SqlLexeme[] {
  let tokens: SqlLexeme[] = []
  scanSqlLexemes(text, (lex) => {
    if (lex.kind === 'punct' && lex.raw === ';') {
      if (lex.start >= offset) return false
      tokens = []
    } else if (lex.kind !== 'whitespace' && lex.kind !== 'lineComment' && lex.kind !== 'blockComment') {
      tokens.push(lex)
    }
  })
  return tokens
}

function groupTokens(tokens: SqlLexeme[], end: number): Group {
  const root: Group = { kind: 'group', delimiter: null, start: 0, end, items: [] }
  const stack = [root]
  for (const token of tokens) {
    const current = stack[stack.length - 1]!
    if (punct(token, '(') || punct(token, '[')) {
      const child: Group = { kind: 'group', delimiter: token.raw as '(' | '[', start: token.end, end, items: [] }
      current.items.push(child)
      stack.push(child)
    } else if (stack.length > 1 && punct(token, current.delimiter === '[' ? ']' : ')')) {
      current.end = token.start
      stack.pop()
    } else {
      current.items.push(token)
    }
  }
  return root
}

/** True for `a`, `a.b`, `a.b.c` — identifiers joined by dots. */
function isColumnChain(parts: Item[]): boolean {
  if (!parts.length) return false
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      if (parts[i]?.kind !== 'ident') return false
    } else if (!punct(parts[i], '.')) {
      return false
    }
  }
  return true
}

/** Output name of one SELECT-list item, or null when it cannot be inferred. */
function outputName(items: Item[]): string | null {
  for (let i = 0; i < items.length - 1; i++) {
    if (keyword(items[i]) === 'AS') return ident(items[i + 1])
  }
  if (items.some((it) => punct(it, '*'))) return null
  // Drop a trailing `::type` so its type name is not read as an alias.
  let end = items.length
  for (let i = 0; i < items.length - 1; i++) {
    if (punct(items[i], ':') && punct(items[i + 1], ':')) { end = i; break }
  }
  const head = items.slice(0, end)
  if (!head.length) return null
  const last = head[head.length - 1]
  // `col alias` / `t.col alias` — a column reference followed by a bare alias.
  if (last?.kind === 'ident' && head.length >= 2 && isColumnChain(head.slice(0, -1))) return ident(last)
  // `f(...)` takes the function's name.
  if (head.length === 2 && head[0]?.kind === 'ident' && head[1]?.kind === 'group') return ident(head[0])
  // A bare or qualified column reference.
  if (isColumnChain(head)) return ident(last)
  return null
}

/** Output columns of `SELECT …` at the head of a group, or null if unknown. */
function inferColumns(group: Group): ColumnInfo[] | null {
  const items = group.items
  if (keyword(items[0]) !== 'SELECT') return null
  let start = 1
  if (keyword(items[start]) === 'DISTINCT') {
    start++
    if (keyword(items[start]) === 'ON' && items[start + 1]?.kind === 'group') start += 2
  } else if (keyword(items[start]) === 'ALL') {
    start++
  }
  let end = items.length
  for (let i = start; i < items.length; i++) {
    if (SELECT_LIST_END.has(keyword(items[i]))) { end = i; break }
  }
  if (start >= end) return null
  if (end - start === 1 && punct(items[start], '*')) return null
  const segments: Item[][] = []
  let segment: Item[] = []
  for (let i = start; i < end; i++) {
    if (punct(items[i], ',')) { segments.push(segment); segment = [] }
    else segment.push(items[i] as Item)
  }
  segments.push(segment)
  const columns: ColumnInfo[] = []
  for (const s of segments) {
    const name = outputName(s)
    if (!name) return null
    columns.push(column(name))
  }
  return columns
}

/** Explicit CTE column names `name (a, b)` — names only, no types. */
function listNames(group: Group): ColumnInfo[] | null {
  const columns: ColumnInfo[] = []
  let expectName = true
  for (const item of group.items) {
    if (expectName) {
      const name = ident(item)
      if (name === null) return null
      columns.push(column(name))
      expectName = false
    } else {
      if (!punct(item, ',')) return null
      expectName = true
    }
  }
  return columns.length && !expectName ? columns : null
}

interface CteDefinition {
  body: Group
  /** Optional `(col, …)` list, which overrides inference. */
  columns: Group | null
}

/** CTE names shadow catalog relations; bodies provide inferred columns. */
function cteDefinitions(items: Item[]): Map<string, CteDefinition> {
  const defs = new Map<string, CteDefinition>()
  if (keyword(items[0]) !== 'WITH') return defs
  let i = keyword(items[1]) === 'RECURSIVE' ? 2 : 1
  while (i < items.length) {
    const name = ident(items[i++])
    if (name === null) break
    const columns = items[i]?.kind === 'group' ? (items[i++] as Group) : null
    if (keyword(items[i++]) !== 'AS') break
    if (keyword(items[i]) === 'NOT') i++
    if (keyword(items[i]) === 'MATERIALIZED') i++
    if (items[i]?.kind !== 'group') break
    defs.set(name, { body: items[i] as Group, columns })
    i++
    if (!punct(items[i], ',')) break
    i++
  }
  return defs
}

/** A set-operation arm has its own relation namespace. */
function branch(items: Item[], offset: number): Item[] {
  let start = 0
  let end = items.length
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!
    if (!SET_OPS.has(keyword(item))) continue
    if (item.start < offset) start = i + 1
    else { end = i; break }
  }
  return items.slice(start, end)
}

function localRelations(items: Item[], ctes: Map<string, RelRef>): QueryScope {
  const aliases = new Map<string, RelRef>()
  const relations: ScopeRelation[] = []
  let hasRelations = false
  let inFrom = false
  let expectRelation = false
  // `INSERT INTO t (a, b)`: the group after the target is the column list, not
  // a table function. `DELETE … USING` adds further sources.
  let insertTarget = false
  const deletes = items.some((it) => keyword(it) === 'DELETE')
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!
    const kw = keyword(item)
    if (kw === 'UPDATE' || kw === 'INTO' || (deletes && kw === 'USING')) {
      inFrom = true
      expectRelation = true
      insertTarget = kw === 'INTO'
      continue
    }
    if (fromClause(items, i) || kw === 'JOIN') {
      inFrom = true
      expectRelation = true
      insertTarget = false
      continue
    }
    if (FROM_END.has(kw)) { inFrom = false; expectRelation = false; insertTarget = false; continue }
    if (inFrom && punct(item, ',')) { expectRelation = true; continue }
    if (!expectRelation) continue
    if (kw === 'LATERAL' || kw === 'ONLY') continue
    expectRelation = false
    let ref: RelRef
    let name: string | null
    if (item.kind === 'group') {
      name = null
      ref = unknown()
    } else {
      name = ident(item)
      if (name === null || NON_ALIAS.has(kw)) continue
      ref = { schema: '', name }
      if (punct(items[i + 1], '.') && ident(items[i + 2]) !== null) {
        ref = { schema: name, name: ident(items[i + 2])! }
        name = ref.name
        i += 2
      } else if (ctes.has(name)) {
        ref = ctes.get(name)!
      }
      // Table functions are sources, but not catalog tables.
      if (!insertTarget && items[i + 1]?.kind === 'group') { ref = unknown(); i++ }
      if (punct(items[i + 1], '*')) i++
    }
    hasRelations = true
    if (keyword(items[i + 1]) === 'AS') i++
    const alias = aliasName(items[i + 1])
    if (alias !== null) {
      i++
      if (item.kind === 'group') {
        const columns = inferColumns(item)
        if (columns) {
          const synth = syntheticFrom(alias, item, columns)
          ref = synth.ref
          relations.push(synth.relation)
        }
      }
      aliases.set(alias, ref)
    } else if (name !== null) {
      aliases.set(name, ref)
    }
  }
  return { aliases, relations, hasRelations }
}

/** Visibility of this query's FROM bindings inside a child group. */
function childVisibility(items: Item[], child: Group): 'all' | 'before' | 'none' {
  let inFrom = false
  let source = false
  let lateral = false
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!
    if (item === child) return source ? (lateral ? 'before' : 'none') : 'all'
    const kw = keyword(item)
    if (fromClause(items, i) || kw === 'JOIN' || (inFrom && punct(item, ','))) {
      inFrom = true
      source = true
      lateral = false
    } else if (FROM_END.has(kw)) {
      inFrom = false
      source = false
    } else if (source && kw === 'LATERAL') {
      lateral = true
    } else if (kw !== 'ONLY') {
      source = false
    }
  }
  return 'all'
}

function mergeScope(outer: QueryScope, inner: QueryScope): QueryScope {
  const relations = [...outer.relations]
  const seen = new Set(relations.map((r) => r.name))
  for (const relation of inner.relations) {
    if (seen.has(relation.name)) continue
    relations.push(relation)
    seen.add(relation.name)
  }
  return {
    aliases: new Map([...outer.aliases, ...inner.aliases]),
    relations,
    hasRelations: outer.hasRelations || inner.hasRelations,
  }
}

/** Path to the cursor, including expression groups enclosing subqueries. */
function cursorPath(root: Group, offset: number): Group[] {
  const path = [root]
  let current = root
  for (;;) {
    const child = current.items.find((item): item is Group =>
      item.kind === 'group' && item.start <= offset && offset <= item.end,
    )
    if (!child) return path
    path.push(child)
    current = child
  }
}

export function resolveQueryScope(text: string, offset = text.length): QueryScope {
  offset = Math.max(0, Math.min(offset, text.length))
  const tokens = statement(text, offset)
  // Preserve SQL completion within routine bodies, while ordinary dollar
  // strings stay opaque. Analyze the body's own statements independently.
  const body = tokens.find((t) => t.kind === 'dollar' && t.start < offset && offset <= t.end)
  if (body && tokens.some((t) => ['FUNCTION', 'PROCEDURE', 'DO'].includes(keyword(t)))) {
    const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(body.raw)?.[0]
    if (tag) {
      const closed = body.raw.length >= tag.length * 2 && body.raw.endsWith(tag)
      const inner = body.raw.slice(tag.length, closed ? -tag.length : undefined)
      const innerOffset = offset - body.start - tag.length
      if (innerOffset >= 0 && innerOffset <= inner.length) return resolveQueryScope(inner, innerOffset)
    }
  }
  const root = groupTokens(tokens, text.length)
  const path = cursorPath(root, offset)
  let scope: QueryScope = { aliases: new Map(), relations: [], hasRelations: false }
  const ctes = new Map<string, RelRef>()
  for (let i = 0; i < path.length; i++) {
    const group = path[i]!
    if (group !== root && !QUERY_START.has(keyword(group.items[0]))) continue
    const definitions = cteDefinitions(group.items)
    const cteRelations: ScopeRelation[] = []
    for (const [name, def] of definitions) {
      const columns = def.columns ? listNames(def.columns) : inferColumns(def.body)
      if (columns) {
        const synth = syntheticFrom(name, def.body, columns)
        ctes.set(name, synth.ref)
        cteRelations.push(synth.relation)
      } else {
        ctes.set(name, unknown())
      }
    }
    const items = branch(group.items, offset)
    const child = path[i + 1]
    if (child) {
      // A CTE or non-LATERAL FROM subquery cannot see this query's FROM.
      const isCteBody = [...definitions.values()].some((d) => d.body === child)
      const visibility = isCteBody ? 'none' : childVisibility(items, child)
      if (visibility === 'none') continue
      if (visibility === 'before') {
        const before = localRelations(items.slice(0, items.indexOf(child)), ctes)
        before.relations = [...cteRelations, ...before.relations]
        scope = mergeScope(scope, before)
        continue
      }
    }
    // Inner aliases shadow outer aliases; sibling subqueries are never read.
    const local = localRelations(items, ctes)
    local.relations = [...cteRelations, ...local.relations]
    scope = mergeScope(scope, local)
  }
  return scope
}
