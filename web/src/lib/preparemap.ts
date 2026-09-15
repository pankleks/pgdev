// PREPARE/EXECUTE template generation for queries written with $N parameters.
// Pure helpers (no Vue/Monaco imports) so the scanner and the script builder
// are unit-testable directly, mirroring sqlsplit/selectshape on the server.
//
// The scanner finds top-level $N references while skipping string literals,
// dollar-quoted bodies, and comments — a `$1` inside a literal or comment is
// text, not a parameter. It also captures each parameter's comparison context
// (the dotted identifier and operator before it), which the caller resolves
// against the loaded schema to pick placeholder values and the PREPARE type
// list.

import { normIdent } from '../monaco/sqlrefs'

export interface ParamRef {
  /** 1-based parameter number ($N). */
  index: number
  /** Normalized (lower-cased) column name the parameter is compared against. */
  column: string | null
  /** Normalized qualifier of that column (`t` in `t.id = $1`), or null. */
  qualifier: string | null
  /** Comparison operator between column and parameter (`=`, `>`, `like`). */
  operator: string | null
}

export interface ParamType {
  /** Type name for the PREPARE list, typmod stripped (`integer`, `boolean`). */
  ddl: string
  /** Placeholder literal for the EXECUTE list (`0`, `TRUE`, `''`, `'{}'`). */
  value: string
}

const OP_WORDS = new Set(['LIKE', 'ILIKE', 'IS', 'NOT', 'BETWEEN', 'SIMILAR'])
// Keywords that terminate a comparison context without being operators.
const BREAK_WORDS = new Set(
  `SELECT FROM WHERE AND OR IN ON AS CASE WHEN THEN ELSE END NULL TRUE FALSE JOIN LEFT RIGHT FULL INNER OUTER CROSS USING GROUP BY ORDER HAVING LIMIT OFFSET FETCH UNION INTERSECT EXCEPT DISTINCT EXISTS RETURNING WITH INSERT INTO VALUES UPDATE SET DELETE DEFAULT`
    .split(' ')
    .map((w) => w.toUpperCase()),
)

interface Token {
  kind: 'ident' | 'op' | 'other'
  /** Verbatim text; quoted identifiers keep their quotes. */
  text: string
}

function isIdentStart(ch: string): boolean {
  return /[A-Za-z_\u0080-\uffff"]/.test(ch)
}

function isIdentPart(ch: string): boolean {
  return /[A-Za-z0-9_$\u0080-\uffff"]/.test(ch)
}

function isOpChar(ch: string): boolean {
  return '=<>!~'.includes(ch)
}

/** Parse one identifier starting at `i` (word or "quoted"), return its end. */
function scanIdent(sql: string, i: number): string {
  if (sql[i] === '"') {
    const re = /"(?:[^"]|"")*"/g
    re.lastIndex = i
    const m = re.exec(sql)
    return m ? m[0] : sql.slice(i, i + 1)
  }
  let j = i + 1
  while (j < sql.length && isIdentPart(sql[j])) j++
  return sql.slice(i, j)
}

/** Walk the token history backwards from just before a `$N`: absorb operator
 * tokens, then take the trailing dotted identifier chain as the column the
 * parameter is compared against. `f($1)` and `IN ($1)` have no operator, so
 * their context stays null. */
function contextFromTokens(tokens: Token[]): {
  column: string | null
  qualifier: string | null
  operator: string | null
} {
  let k = tokens.length - 1
  const ops: string[] = []
  while (k >= 0 && tokens[k].kind === 'op') {
    ops.unshift(tokens[k].text)
    k--
  }
  if (!ops.length || k < 0 || tokens[k].kind !== 'ident') {
    return { column: null, qualifier: null, operator: ops.length ? ops.join(' ') : null }
  }
  const parts = [tokens[k].text]
  while (k - 2 >= 0 && tokens[k - 1].text === '.' && tokens[k - 2].kind === 'ident') {
    parts.unshift(tokens[k - 2].text)
    k -= 2
  }
  const column = normIdent(parts[parts.length - 1])
  const qualifier = parts.length > 1 ? normIdent(parts[0]) : null
  return { column, qualifier, operator: ops.join(' ') }
}

/**
 * Find the top-level $N parameters of one statement, each with the dotted
 * identifier and comparison operator directly preceding it (when present).
 * Repeated parameters appear once, at first use.
 */
export function findParams(sql: string): ParamRef[] | null {
  const byIndex = new Map<number, ParamRef>()
  const tokens: Token[] = []
  const push = (kind: Token['kind'], text: string) => {
    tokens.push({ kind, text })
    if (tokens.length > 32) tokens.shift()
  }

  let i = 0
  const n = sql.length
  while (i < n) {
    const ch = sql[i]

    if (ch === '-' && sql[i + 1] === '-') {
      const stop = sql.indexOf('\n', i + 2)
      i = stop === -1 ? n : stop + 1
      continue
    }
    if (ch === '/' && sql[i + 1] === '*') {
      let depth = 1
      i += 2
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth++
          i += 2
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--
          i += 2
        } else i++
      }
      continue
    }
    if (ch === "'") {
      // E'' strings allow backslash escapes; plain strings do not.
      const escapeQuotes = /(^|[^A-Za-z0-9_$])[eE]$/.test(sql.slice(Math.max(0, i - 2), i))
      i++
      while (i < n) {
        if (sql[i] === '\\' && escapeQuotes) {
          i += 2
          continue
        }
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2
            continue
          }
          i++
          break
        }
        i++
      }
      push('other', '…')
      continue
    }
    if (ch === '$') {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 64))?.[0]
      if (tag) {
        const close = sql.indexOf(tag, i + tag.length)
        i = close === -1 ? n : close + tag.length
        push('other', '…')
        continue
      }
      if (/[0-9]/.test(sql[i + 1] ?? '')) {
        let j = i + 1
        while (j < n && /[0-9]/.test(sql[j])) j++
        const index = Number(sql.slice(i + 1, j))
        if (index > 0) {
          if (!byIndex.has(index)) {
            const ref = contextFromTokens(tokens)
            byIndex.set(index, {
              index,
              column: ref.column,
              qualifier: ref.qualifier,
              operator: ref.operator,
            })
          }
          i = j
          continue
        }
      }
      // Bare `$` or an unusable fragment: punctuation, not a parameter.
      push('other', '$')
      i++
      continue
    }

    if (isIdentStart(ch)) {
      const word = scanIdent(sql, i)
      i += word.length
      const folded = word.startsWith('"') ? word : word.toUpperCase()
      if (OP_WORDS.has(folded)) push('op', folded.toLowerCase())
      else if (BREAK_WORDS.has(folded)) push('other', word)
      else push('ident', word)
      continue
    }
    if (isOpChar(ch)) {
      let j = i
      while (j < n && isOpChar(sql[j])) j++
      push('op', sql.slice(i, j))
      i = j
      continue
    }
    // Parentheses, commas and any other punctuation reset the context.
    if (!/\s/.test(ch)) push('other', ch)
    i++
  }

  if (!byIndex.size) return null
  return [...byIndex.values()].sort((a, b) => a.index - b.index)
}

// ---- script building -------------------------------------------------------

/** Strip typmod so PREPARE's type list stays valid (`numeric(10,2)` → `numeric`). */
function ddlType(pgType: string): string {
  return pgType.replace(/\s*\([^)]*\)\s*$/, '').trim()
}

/** Map a resolved column type to the EXECUTE placeholder literal. */
export function paramDefaultValue(pgType: string): string {
  const t = pgType.toLowerCase()
  if (/^bool/.test(t)) return 'TRUE'
  if (
    /^(int2|int4|int8|smallint|integer|bigint|oid|numeric|decimal|real|double precision|money|smallserial|serial|bigserial)\b/.test(
      t,
    )
  )
    return '0'
  if (/^(text|character|varchar|char|citext|name|uuid)\b/.test(t)) return "''"
  if (/^(date|timestamp|timestamptz|time|timetz|interval)\b/.test(t)) return "'now'"
  if (/^(json|jsonb)\b/.test(t)) return "'{}'"
  return 'NULL'
}

export function paramTypeOf(pgType: string): ParamType {
  return { ddl: ddlType(pgType), value: paramDefaultValue(pgType) }
}

/** `PREPARE temp [types] AS` + the query, EXECUTE with placeholder values, DEALLOCATE. */
export function prepareScript(sql: string, types: (string | null)[], values: (string | null)[]): string {
  // The query needs a terminator: add `;` when the statement's code portion
  // is unterminated. A trailing line comment must not swallow it, so in that
  // case the `;` gets its own line.
  let body = sql.trim()
  const lastLine = body.slice(body.lastIndexOf('\n') + 1)
  const commentStart = lastLine.indexOf('--')
  const codeTail = (commentStart === -1 ? lastLine : lastLine.slice(0, commentStart)).trimEnd()
  if (!codeTail.endsWith(';')) {
    body = commentStart !== -1 ? `${body}\n;` : `${body};`
  }
  const indented = body
    .split('\n')
    .map((line) => `\t${line}`)
    .join('\n')
  const typed = types.length > 0 && types.every((t) => t !== null)
  const head = typed ? `PREPARE temp(${types.join(', ')}) AS` : 'PREPARE temp AS'
  const argLines = values
    .map((v, i) => `\t${v ?? 'NULL'}${i < values.length - 1 ? ',' : ''} -- $${i + 1}`)
    .join('\n')
  return [head, indented, '', '', `EXECUTE temp(\n${argLines}\n);`, '', '', 'DEALLOCATE temp;'].join('\n')
}

/**
 * Build the full PREPARE/EXECUTE/DEALLOCATE script for `sql`, or null when it
 * has no top-level $N parameters. `resolve` maps one parameter to its type;
 * a null result (or a gap like `$1, $3`) yields `NULL`, and the type list is
 * omitted entirely unless every parameter resolved — PostgreSQL only infers
 * omitted types on 16+, while an all-or-nothing list works everywhere.
 */
/**
 * Convert one parsed parameter value to a SQL literal: numbers pass through,
 * strings get single-quote escaping, booleans become TRUE/FALSE, null/undefined
 * become NULL, arrays become ARRAY[...] (`'{}'` when empty — the PREPARE
 * type list casts it), objects become JSON string literals.
 */
export function sqlLiteral(v: unknown): string {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL'
  if (typeof v === 'string') return `'${v.replace(/'/g, "''")}'`
  if (Array.isArray(v)) return v.length ? `ARRAY[${v.map(sqlLiteral).join(', ')}]` : "'{}'"
  if (typeof v === 'object') return `'${JSON.stringify(v).replace(/'/g, "''")}'`
  return 'NULL'
}

/**
 * Parse an optional parameter-values payload: a JSON array, optionally
 * preceded by `--` (values often arrive as a comment line from logs).
 * A bare value without brackets is wrapped into a one-element array;
 * anything unparseable yields null.
 */
export function parseParamValues(text: string): unknown[] | null {
  let t = text.trim()
  if (t.startsWith('--')) t = t.slice(2).trim()
  if (!t) return null
  if (!t.startsWith('[')) t = `[${t}]`
  try {
    const parsed: unknown = JSON.parse(t)
    return Array.isArray(parsed) ? parsed : [parsed]
  } catch {
    return null
  }
}

export function mapParams(
  sql: string,
  resolve: (ref: ParamRef) => ParamType | null,
  override?: unknown[],
): { script: string; typed: boolean } | null {
  const refs = findParams(sql)
  if (!refs?.length) return null
  const byIndex = new Map(refs.map((r) => [r.index, r]))
  const max = Math.max(...refs.map((r) => r.index))
  const types: (string | null)[] = []
  const values: string[] = []
  let typed = true
  for (let n = 1; n <= max; n++) {
    const ref = byIndex.get(n) ?? { index: n, column: null, qualifier: null, operator: null }
    // Values pasted into the input bar win positionally; types still come
    // from the schema resolution, and unresolved parameters stay untyped.
    if (override && override.length >= n) {
      values.push(sqlLiteral(override[n - 1]))
      const t = resolve(ref)
      types.push(t ? t.ddl : null)
      if (!t) typed = false
      continue
    }
    const t = resolve(ref)
    if (t) {
      types.push(t.ddl)
      values.push(t.value)
    } else {
      types.push(null)
      values.push('NULL')
      typed = false
    }
  }
  return { script: prepareScript(sql, types, values), typed }
}
