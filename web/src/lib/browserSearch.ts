// Pure helpers behind the object-browser search: query parsing, term
// matching, highlighting, and function-argument parsing. No Vue imports —
// everything here is unit-testable directly.

export type SearchType = 'table' | 'view' | 'function' | 'column' | 'parameter' | 'type'

const TYPE_WORDS: Record<string, SearchType> = {
  table: 'table',
  tables: 'table',
  view: 'view',
  views: 'view',
  function: 'function',
  functions: 'function',
  func: 'function',
  fn: 'function',
  column: 'column',
  columns: 'column',
  col: 'column',
  param: 'parameter',
  params: 'parameter',
  parameter: 'parameter',
  parameters: 'parameter',
  type: 'type',
  types: 'type',
}

export interface ParsedSearch {
  term: string
  type: SearchType | null
}

/** `"unit table"`, `col id`, `fn count` — a trailing/leading word picks the section. */
export function parseSearch(query: string): ParsedSearch {
  const q = query.trim().toLowerCase()
  if (!q) return { term: '', type: null }
  const tokens = q.split(/\s+/)
  const last = tokens[tokens.length - 1]
  if (tokens.length > 1 && TYPE_WORDS[last]) {
    return { term: tokens.slice(0, -1).join(' '), type: TYPE_WORDS[last] }
  }
  if (TYPE_WORDS[tokens[0]]) {
    return { term: tokens.slice(1).join(' '), type: TYPE_WORDS[tokens[0]] }
  }
  return { term: q, type: null }
}

/** Space-separated groups are ORed; `+`-joined terms inside a group are ANDed.
 * `employee+labor` needs both, `employee labor` needs either. */
export type SearchTerms = string[][]

export function searchTerms(term: string): SearchTerms {
  return term
    .split(/\s+/)
    .filter(Boolean)
    .map((group) => group.split('+').filter(Boolean))
    .filter((group) => group.length > 0)
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char] ?? char)
}

// Compiling the pattern is not free and rendering calls this for every
// visible label on every keystroke — cache per term set (matchAll clones the
// regex, so sharing one instance is safe).
const patternCache = new Map<string, RegExp>()

function highlightPattern(rawTerms: string[]): RegExp | null {
  if (!rawTerms.length) return null
  const key = [...new Set(rawTerms)].sort((a, b) => b.length - a.length).join('\u0000')
  let pattern = patternCache.get(key)
  if (!pattern) {
    pattern = new RegExp(key.split('\u0000').map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi')
    if (patternCache.size >= 32) patternCache.clear()
    patternCache.set(key, pattern)
  }
  return pattern
}

/** Escape everything, then wrap case-insensitive term hits in `<mark>`. Only
 * the terms of the groups that actually match are marked: under an AND search
 * like `employee+labor`, a column matching only `employee` marks nothing,
 * while an OR search `employee labor` marks whichever term it contains. */
export function highlightTerms(value: string, groups: SearchTerms): string {
  const candidate = value.toLowerCase()
  const matched = groups
    .filter((group) => group.every((term) => candidate.includes(term)))
    .flat()
  const pattern = highlightPattern(matched)
  if (!pattern) return escapeHtml(value)

  let result = ''
  let lastIndex = 0
  for (const match of value.matchAll(pattern)) {
    const index = match.index ?? 0
    result += escapeHtml(value.slice(lastIndex, index))
    result += `<mark class="search-hit">${escapeHtml(match[0])}</mark>`
    lastIndex = index + match[0].length
  }
  return result + escapeHtml(value.slice(lastIndex))
}

/** Highlight a label only when its kind belongs to the active search type.
 * `scopes` lists the types that make the label a search target; an empty list
 * marks supporting detail (indexes, type text), highlighted only when the
 * search is untyped. So a `table` search never marks a column inside a matched
 * table. */
export function scopedHighlight(
  value: string,
  groups: SearchTerms,
  queryType: SearchType | null,
  scopes: SearchType[],
): string {
  if (queryType !== null && !scopes.includes(queryType)) return escapeHtml(value)
  return highlightTerms(value, groups)
}

/** A value matches when every term of at least one group appears in it. */
export function matchesTerms(value: string, groups: SearchTerms): boolean {
  const candidate = value.toLowerCase()
  return groups.some((group) => group.every((term) => candidate.includes(term)))
}

export function nameMatches(name: string, schema: string, groups: SearchTerms): boolean {
  const nameText = name.toLowerCase()
  const schemaText = schema.toLowerCase()
  return groups.some((group) => group.every((term) => nameText.includes(term) || schemaText.includes(term)))
}

export function columnsMatch(cols: { name: string }[], groups: SearchTerms): boolean {
  return cols.some((c) => matchesTerms(c.name, groups))
}

export function splitArgs(args: string): string[] {
  const trimmed = args.trim()
  if (!trimmed) return []
  const parts: string[] = []
  let depth = 0
  let quote: string | null = null
  let cur = ''
  for (const ch of trimmed) {
    if (quote) {
      cur += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      cur += ch
      continue
    }
    if (ch === '(') depth++
    else if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      parts.push(cur.trim())
      cur = ''
    } else {
      cur += ch
    }
  }
  if (cur.trim()) parts.push(cur.trim())
  return parts
}

const PARAM_MODES = ['IN', 'OUT', 'INOUT', 'VARIADIC']

export type ParamKind = 'in' | 'out' | 'inout' | 'variadic' | 'returns'

export interface ParamRow {
  kind: ParamKind
  name: string
  rest: string
}

// Argument text repeats heavily across overloads and renders — parse once.
// The cached array is shared: callers must not mutate it.
const paramCache = new Map<string, ParamRow[]>()

export function paramRows(args: string, returns: string): ParamRow[] {
  const key = `${args}\u0000${returns}`
  let rows = paramCache.get(key)
  if (!rows) {
    rows = splitArgs(args).map((a): ParamRow => {
      const words = a.split(/\s+/)
      let kind: ParamKind = 'in'
      let i = 0
      const first = words[0]?.toUpperCase()
      if (words.length > 1 && PARAM_MODES.includes(first)) {
        kind = first === 'OUT' ? 'out' : first === 'INOUT' ? 'inout' : first === 'VARIADIC' ? 'variadic' : 'in'
        i = 1
      }
      if (words.length > i + 1) {
        return { kind, name: words.slice(i, i + 1).join(' '), rest: words.slice(i + 1).join(' ') }
      }
      return { kind, name: words.length > i ? words.slice(i).join(' ') : a, rest: '' }
    })
    rows.push({ kind: 'returns', name: 'returns', rest: returns })
    if (paramCache.size >= 512) paramCache.clear()
    paramCache.set(key, rows)
  }
  return rows
}

/** Any non-returns parameter matches at least one term group. */
export function paramsMatch(args: string, groups: SearchTerms): boolean {
  return paramRows(args, '').some((p) => p.kind !== 'returns' && matchesTerms(p.name, groups))
}

/** While filtering, a relation whose columns match but whose name does not opens itself. */
export function autoExpandRelation(
  name: string,
  schema: string,
  cols: { name: string }[],
  filtering: boolean,
  groups: SearchTerms,
): boolean {
  return filtering && !nameMatches(name, schema, groups) && columnsMatch(cols, groups)
}

export function autoExpandFunction(
  name: string,
  schema: string,
  typeSig: string,
  args: string,
  filtering: boolean,
  groups: SearchTerms,
): boolean {
  return (
    filtering &&
    !nameMatches(name, schema, groups) &&
    (matchesTerms(typeSig, groups) || paramsMatch(args, groups))
  )
}
