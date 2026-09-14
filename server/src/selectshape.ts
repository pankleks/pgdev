// Plain single-table SELECT detection for the row editor: decides whether a
// statement's rows have an unambiguous table identity, so an UPDATE can be
// built from the result. Conservative by design — a false negative just means
// no edit buttons, a false positive would mean updating the wrong table.
//
// Accepted:  SELECT [* | column list] FROM [schema.]table [AS alias] [WHERE …]
//            [ORDER BY …] [LIMIT …] [OFFSET …] [FETCH …]
// Rejected:  joins, set operations (UNION/…), CTEs, DISTINCT, GROUP BY,
//            HAVING, WINDOW, subqueries or functions in FROM, SELECT INTO,
//            locking clauses (FOR UPDATE/SHARE), multiple FROM items.
// The select list must be `*`, `qualifier.*` or plain column references only:
// an expression aliased to a real column name (`id + 1 AS id`) would make the
// row editor send a value that no longer identifies the row it came from.

export interface PlainSelectSource {
  /** Schema when the statement qualifies the table, else null (search_path). */
  schema: string | null
  /** Table name with unquoted identifiers folded to lower case. */
  table: string
  /** Output names of the plain column references selected, or null when the
   * list includes `*`/`qualifier.*` (every table column may appear). */
  columns: string[] | null
}

type TokenKind = 'word' | 'ident' | 'punct' | 'literal'

interface Token {
  kind: TokenKind
  /** Lower-cased for words; verbatim for quoted identifiers and literals. */
  text: string
  /** Parenthesis depth at this token (0 = top level). */
  depth: number
}

const CLAUSE_START = new Set(['where', 'order', 'limit', 'offset', 'fetch'])
const REJECT_WORDS = new Set([
  'group', 'having', 'union', 'intersect', 'except', 'window', 'into', 'for', 'join',
])
const NOT_AN_ALIAS = new Set([
  ...CLAUSE_START,
  ...REJECT_WORDS,
  'on', 'using', 'outer', 'left', 'right', 'full', 'inner', 'cross', 'natural',
  'lateral', 'by', 'tablesample',
])
const NOT_A_TABLE = new Set([
  'only', 'values', 'select', 'from', 'where', 'on', 'using', 'as',
  ...REJECT_WORDS, 'tablesample',
])

/**
 * Split SQL into tokens, skipping comments and hiding string/dollar-quoted
 * bodies as opaque literals so their contents can never look like keywords or
 * parentheses. Mirrors the scanner rules in sqlsplit.ts (nested block
 * comments, '' escapes, $tag$ bodies).
 */
function tokenize(sql: string): Token[] {
  const out: Token[] = []
  let i = 0
  const n = sql.length

  while (i < n) {
    const ch = sql[i] as string

    if (/\s/.test(ch)) {
      i++
      continue
    }
    if (ch === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i + 2)
      i = end === -1 ? n : end
      continue
    }
    if (ch === '/' && sql[i + 1] === '*') {
      let depth = 1
      let j = i + 2
      while (j < n && depth > 0) {
        if (sql[j] === '/' && sql[j + 1] === '*') {
          depth++
          j += 2
        } else if (sql[j] === '*' && sql[j + 1] === '/') {
          depth--
          j += 2
        } else {
          j++
        }
      }
      i = j
      continue
    }
    if (ch === "'") {
      let j = i + 1
      while (j < n) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") j += 2
          else {
            j++
            break
          }
        } else {
          j++
        }
      }
      out.push({ kind: 'literal', text: sql.slice(i, j), depth: 0 })
      i = j
      continue
    }
    if (ch === '"') {
      let j = i + 1
      let text = ''
      while (j < n) {
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') {
            text += '"'
            j += 2
          } else {
            j++
            break
          }
        } else {
          text += sql[j]
          j++
        }
      }
      out.push({ kind: 'ident', text, depth: 0 })
      i = j
      continue
    }
    if (ch === '$') {
      const previous = sql[i - 1]
      const tag =
        (!previous || !/[A-Za-z0-9_$]/.test(previous)) &&
        /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))
      if (tag) {
        const close = sql.indexOf(tag[0], i + tag[0].length)
        i = close === -1 ? n : close + tag[0].length
        out.push({ kind: 'literal', text: '', depth: 0 })
        continue
      }
      out.push({ kind: 'punct', text: ch, depth: 0 })
      i++
      continue
    }
    if (/[A-Za-z_\u0080-\uffff]/.test(ch)) {
      let j = i + 1
      while (j < n && /[A-Za-z0-9_$\u0080-\uffff]/.test(sql[j] as string)) j++
      out.push({ kind: 'word', text: sql.slice(i, j).toLowerCase(), depth: 0 })
      i = j
      continue
    }
    if (/[0-9]/.test(ch)) {
      let j = i + 1
      while (j < n && /[0-9A-Za-z_]/.test(sql[j] as string)) j++
      out.push({ kind: 'literal', text: sql.slice(i, j), depth: 0 })
      i = j
      continue
    }
    out.push({ kind: 'punct', text: ch, depth: 0 })
    i++
  }

  let depth = 0
  for (const t of out) {
    if (t.kind === 'punct' && t.text === '(') {
      t.depth = depth
      depth++
    } else if (t.kind === 'punct' && t.text === ')') {
      depth = Math.max(0, depth - 1)
      t.depth = depth
    } else {
      t.depth = depth
    }
  }
  return out
}

function isWord(t: Token | undefined, text: string): boolean {
  return t?.kind === 'word' && t.text === text
}

function isPunct(t: Token | undefined, text: string): boolean {
  return t?.kind === 'punct' && t.text === text
}

function nameable(t: Token | undefined): t is Token {
  return (t?.kind === 'word' || t?.kind === 'ident') && t.depth === 0
}

/**
 * Classify a select list: `*` / `qualifier.*` (all columns may appear) or
 * plain (possibly qualified) column references. Returns null for anything
 * else — an expression, cast or alias has an output name this module cannot
 * prove maps back to a live column, so editing is refused outright.
 */
function parseSelectList(tokens: Token[]): { stars: boolean; columns: string[] } | null {
  let stars = false
  const columns: string[] = []
  let item: Token[] = []

  const flush = (): boolean => {
    if (!item.length) return false
    const parts = item
    if (parts.length === 1 && isPunct(parts[0], '*')) {
      stars = true
      return true
    }
    if (parts.length === 3 && nameable(parts[0]) && isPunct(parts[1], '.') && isPunct(parts[2], '*')) {
      stars = true
      return true
    }
    if (parts.length === 1 && nameable(parts[0])) {
      columns.push(parts[0].text)
      return true
    }
    if (
      parts.length === 3 &&
      nameable(parts[0]) && isPunct(parts[1], '.') && nameable(parts[2])
    ) {
      columns.push(parts[2].text)
      return true
    }
    if (
      parts.length === 5 &&
      nameable(parts[0]) && isPunct(parts[1], '.') && nameable(parts[2]) &&
      isPunct(parts[3], '.') && nameable(parts[4])
    ) {
      columns.push(parts[4].text)
      return true
    }
    return false
  }

  for (const tok of tokens) {
    if (tok.depth !== 0) return null // parentheses, casts, subqueries
    if (isPunct(tok, ',')) {
      if (!flush()) return null
      item = []
      continue
    }
    item.push(tok)
  }
  if (!flush()) return null
  return { stars, columns }
}

/** Detect the plain single-table source of a statement, or null. */
export function plainSelectTable(sql: string): PlainSelectSource | null {
  const t = tokenize(sql)
  if (!isWord(t[0], 'select')) return null

  let i = 1
  if (isWord(t[i], 'all')) i++
  if (isWord(t[i], 'distinct')) return null
  const listStart = i

  // Find the top-level FROM; reject SELECT INTO on the way.
  let from = -1
  for (; i < t.length; i++) {
    const tok = t[i] as Token
    if (tok.depth !== 0) continue
    if (tok.kind === 'word' && tok.text === 'from') {
      from = i
      break
    }
    if (tok.kind === 'word' && tok.text === 'into') return null
  }
  if (from === -1) return null

  const list = parseSelectList(t.slice(listStart, from))
  if (!list) return null

  let p = from + 1
  const first = t[p]
  if (!nameable(first) || (first.kind === 'word' && NOT_A_TABLE.has(first.text))) return null

  let schema: string | null = null
  let table: string
  if (isPunct(t[p + 1], '.')) {
    const second = t[p + 2]
    if (!nameable(second) || (second.kind === 'word' && NOT_A_TABLE.has(second.text))) return null
    schema = first.text
    table = second.text
    p += 3
  } else {
    table = first.text
    p += 1
  }
  // A call where a table belongs is a set-returning function, not a table.
  if (isPunct(t[p], '(')) return null

  // Optional alias: `[AS] name`; a bare clause/reject keyword is not an alias.
  if (isWord(t[p], 'as')) {
    const alias = t[p + 1]
    if (!nameable(alias)) return null
    p += 2
  } else if (nameable(t[p]) && !(t[p]?.kind === 'word' && NOT_AN_ALIAS.has(t[p]?.text ?? ''))) {
    p += 1
  }

  // After the target only a clause start (or the end) may follow.
  const after = t[p]
  if (after && !(after.kind === 'punct' && after.text === ';')) {
    if (!(after.kind === 'word' && after.depth === 0 && CLAUSE_START.has(after.text))) return null
  }

  // No rejected construct may appear at the top level (WHERE's function calls
  // such as left()/right() are exempt because only the listed words reject).
  for (let k = p; k < t.length; k++) {
    const tok = t[k] as Token
    if (tok.kind === 'word' && tok.depth === 0 && REJECT_WORDS.has(tok.text)) return null
  }

  return { schema, table, columns: list.stars ? null : list.columns }
}
