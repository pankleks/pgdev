// Cursor-aware relation scope shared by completion and hover. This is a
// tolerant scope parser, not a SQL validator: unfinished statements and open
// parentheses are normal editor input. Catalog-independent derived relations
// are recorded as unresolved bindings so they cannot resolve to unrelated
// catalog tables with the same name.
import { scanSqlLexemes, type SqlLexeme } from '../../../server/src/sqllex'
import type { RelRef } from './sqlrefs'

interface Group {
  kind: 'group'
  delimiter: '(' | '[' | null
  start: number
  end: number
  items: Item[]
}
type Item = SqlLexeme | Group

export interface QueryScope {
  aliases: Map<string, RelRef>
  /** A FROM source exists even when its columns are not yet known. */
  hasRelations: boolean
}

const NON_ALIAS = new Set(
  ('SELECT FROM WHERE JOIN INNER LEFT RIGHT FULL OUTER CROSS ON AS AND OR NOT NULL IS IN BETWEEN LIKE ILIKE ' +
    'GROUP BY ORDER HAVING LIMIT OFFSET INSERT INTO VALUES UPDATE SET DELETE RETURNING CREATE TABLE VIEW ' +
    'MATERIALIZED INDEX DROP ALTER ADD COLUMN DISTINCT CASE WHEN THEN ELSE END UNION INTERSECT EXCEPT ALL ' +
    'EXISTS ASC DESC WITH OVER PARTITION WINDOW FILTER FETCH FOR NATURAL USING TRUE FALSE PRIMARY KEY ' +
    'FOREIGN REFERENCES CHECK DEFAULT CONSTRAINT UNIQUE CASCADE GRANT COMMENT ANALYZE EXPLAIN TRUNCATE ' +
    'BEGIN COMMIT ROLLBACK LATERAL ONLY TABLESAMPLE REPEATABLE RECURSIVE SEARCH CYCLE')
    .split(' '),
)
const FROM_END = new Set(['WHERE', 'GROUP', 'HAVING', 'WINDOW', 'ORDER', 'LIMIT', 'OFFSET', 'FETCH', 'FOR', 'RETURNING', 'SET'])
const SET_OPS = new Set(['UNION', 'INTERSECT', 'EXCEPT'])
const QUERY_START = new Set(['SELECT', 'WITH', 'VALUES', 'TABLE'])

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

/** CTE names shadow catalog relations; output-column inference is separate. */
function cteDefinitions(items: Item[]): Map<string, Group> {
  const bindings = new Map<string, Group>()
  if (keyword(items[0]) !== 'WITH') return bindings
  let i = keyword(items[1]) === 'RECURSIVE' ? 2 : 1
  while (i < items.length) {
    const name = ident(items[i++])
    if (name === null) break
    if (items[i]?.kind === 'group') i++ // optional output-column names
    if (keyword(items[i++]) !== 'AS') break
    if (keyword(items[i]) === 'NOT') i++
    if (keyword(items[i]) === 'MATERIALIZED') i++
    if (items[i]?.kind !== 'group') break
    bindings.set(name, items[i] as Group)
    i++
    if (!punct(items[i], ',')) break
    i++
  }
  return bindings
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
  let hasRelations = false
  let inFrom = false
  let expectRelation = false
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!
    const kw = keyword(item)
    if (fromClause(items, i) || kw === 'JOIN') {
      inFrom = true
      expectRelation = true
      continue
    }
    if (FROM_END.has(kw)) { inFrom = false; expectRelation = false; continue }
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
      if (items[i + 1]?.kind === 'group') { ref = unknown(); i++ }
      if (punct(items[i + 1], '*')) i++
    }
    hasRelations = true
    if (keyword(items[i + 1]) === 'AS') i++
    const alias = aliasName(items[i + 1])
    if (alias !== null) {
      aliases.set(alias, ref)
      i++
    } else if (name !== null) {
      aliases.set(name, ref)
    }
  }
  return { aliases, hasRelations }
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
  return {
    aliases: new Map([...outer.aliases, ...inner.aliases]),
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
  let scope: QueryScope = { aliases: new Map(), hasRelations: false }
  const ctes = new Map<string, RelRef>()
  for (let i = 0; i < path.length; i++) {
    const group = path[i]!
    if (group !== root && !QUERY_START.has(keyword(group.items[0]))) continue
    const definitions = cteDefinitions(group.items)
    for (const name of definitions.keys()) ctes.set(name, unknown())
    const items = branch(group.items, offset)
    const local = localRelations(items, ctes)
    const child = path[i + 1]
    if (child) {
      // A CTE or non-LATERAL FROM subquery cannot see this query's FROM.
      const visibility = [...definitions.values()].includes(child) ? 'none' : childVisibility(items, child)
      if (visibility === 'none') continue
      if (visibility === 'before') {
        scope = mergeScope(scope, localRelations(items.slice(0, items.indexOf(child)), ctes))
        continue
      }
    }
    // Inner aliases shadow outer aliases; sibling subqueries are never read.
    scope = mergeScope(scope, local)
  }
  return scope
}
