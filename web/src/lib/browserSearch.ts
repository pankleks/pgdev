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

/** The search term splits into per-word terms on spaces and `+`. */
export function searchTerms(term: string): string[] {
  return term.split(/[+\s]+/).filter(Boolean)
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

/** Escape everything, then wrap case-insensitive term hits in `<mark>`. */
export function highlightTerms(value: string, rawTerms: string[]): string {
  const pattern = highlightPattern(rawTerms)
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

/** Every term must appear somewhere in the value. */
export function matchesTerms(value: string, terms: string[]): boolean {
  const candidate = value.toLowerCase()
  return terms.every((term) => candidate.includes(term))
}

export function nameMatches(name: string, schema: string, terms: string[]): boolean {
  const nameText = name.toLowerCase()
  const schemaText = schema.toLowerCase()
  return terms.every((term) => nameText.includes(term) || schemaText.includes(term))
}

export function columnsMatch(cols: { name: string }[], terms: string[]): boolean {
  return cols.some((c) => matchesTerms(c.name, terms))
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

/** Any non-returns parameter matches every term. */
export function paramsMatch(args: string, terms: string[]): boolean {
  return paramRows(args, '').some((p) => p.kind !== 'returns' && matchesTerms(p.name, terms))
}

/** While filtering, a relation whose columns match but whose name does not opens itself. */
export function autoExpandRelation(
  name: string,
  schema: string,
  cols: { name: string }[],
  filtering: boolean,
  terms: string[],
): boolean {
  return filtering && !nameMatches(name, schema, terms) && columnsMatch(cols, terms)
}

export function autoExpandFunction(
  name: string,
  schema: string,
  typeSig: string,
  args: string,
  filtering: boolean,
  terms: string[],
): boolean {
  return (
    filtering &&
    !nameMatches(name, schema, terms) &&
    (matchesTerms(typeSig, terms) || paramsMatch(args, terms))
  )
}
