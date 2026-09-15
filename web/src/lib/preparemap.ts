// PREPARE/EXECUTE template generation for queries written with $N parameters.
// Pure helpers (no Vue/Monaco imports) so the scanner and the script builder
// are unit-testable directly, mirroring sqlsplit/selectshape on the server.
//
// The scanner finds top-level $N references while skipping string literals,
// dollar-quoted bodies, comments, and identifiers that merely contain a `$`
// (`a$1` is a name, not a parameter). Parameter types are never resolved:
// PostgreSQL infers them from the query context — a parameter compared against
// a column takes that column's type — so the template declares no type list
// and the EXECUTE values are the caller's pasted literals or NULL.

function isIdentStart(ch: string): boolean {
  return /[A-Za-z_\u0080-\uffff"]/.test(ch)
}

function isIdentPart(ch: string): boolean {
  return /[A-Za-z0-9_$\u0080-\uffff"]/.test(ch)
}

/** Parse one identifier starting at `i` (word or "quoted"), return its text. */
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

/**
 * Indices of the top-level $N parameters of one statement, in first-use
 * order. Repeated parameters appear once.
 */
export function findParams(sql: string): number[] | null {
  const indices: number[] = []
  const seen = new Set<number>()

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
      continue
    }
    // An identifier may contain `$`, so consume the whole word first.
    if (isIdentStart(ch)) {
      i += scanIdent(sql, i).length
      continue
    }
    if (ch === '$') {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 64))?.[0]
      if (tag) {
        const close = sql.indexOf(tag, i + tag.length)
        i = close === -1 ? n : close + tag.length
        continue
      }
      if (/[0-9]/.test(sql[i + 1] ?? '')) {
        let j = i + 1
        while (j < n && /[0-9]/.test(sql[j])) j++
        const index = Number(sql.slice(i + 1, j))
        if (index > 0 && !seen.has(index)) {
          seen.add(index)
          indices.push(index)
        }
        i = j
        continue
      }
      // Bare `$` or an unusable fragment: punctuation, not a parameter.
      i++
      continue
    }
    i++
  }

  return indices.length ? indices : null
}

/** `PREPARE temp AS` + the query, `EXECUTE` with one value per parameter, `DEALLOCATE`. */
export function prepareScript(sql: string, values: string[]): string {
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
  const argLines = values
    .map((v, i) => `\t${v}${i < values.length - 1 ? ',' : ''} -- $${i + 1}`)
    .join('\n')
  return ['PREPARE temp AS', indented, '', '', `EXECUTE temp(\n${argLines}\n);`, '', '', 'DEALLOCATE temp;'].join('\n')
}

/**
 * Convert one parsed parameter value to a SQL literal: numbers pass through,
 * strings get single-quote escaping, booleans become TRUE/FALSE, null/undefined
 * become NULL, arrays become ARRAY[...] (`'{}'` when empty — an unknown literal
 * is coerced to the parameter's inferred type), objects become JSON literals.
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

/**
 * Build the full PREPARE/EXECUTE/DEALLOCATE script for `sql`, or null when it
 * has no top-level $N parameters. Pasted values apply positionally; every
 * parameter without one gets `NULL`, and a gap like `$1, $3` fills in too.
 */
export function mapParams(sql: string, override?: unknown[]): string | null {
  const indices = findParams(sql)
  if (!indices?.length) return null
  const max = Math.max(...indices)
  const values: string[] = []
  for (let n = 1; n <= max; n++) {
    values.push(override && override.length >= n ? sqlLiteral(override[n - 1]) : 'NULL')
  }
  return prepareScript(sql, values)
}
