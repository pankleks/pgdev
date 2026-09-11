// Split SQL text into individual statements on top-level semicolons.
// Aware of single-quoted strings ('' escape), double-quoted identifiers,
// line/block comments, and dollar-quoted bodies ($$…$$, $tag$…$tag$),
// so function bodies and literals containing `;` stay intact.

export function splitStatements(sql: string): string[] {
  const out: string[] = []
  let cur = ''
  let i = 0
  const n = sql.length
  let standardConformingStrings = true

  const finish = () => {
    const statement = cur.trim()
    if (!statement) return
    out.push(statement)
    const setting = /\bstandard_conforming_strings\s*(?:=|TO)\s*['"]?(on|off)\b/i.exec(statement)
    if (setting) standardConformingStrings = setting[1].toLowerCase() === 'on'
  }

  while (i < n) {
    const ch = sql[i]

    // Line comment.
    if (ch === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i + 2)
      const stop = end === -1 ? n : end
      cur += sql.slice(i, stop)
      i = stop
      continue
    }
    // Block comment.
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
      cur += sql.slice(i, j)
      i = j
      continue
    }
    // Single-quoted string.
    if (ch === "'") {
      const escapeBackslashes = !standardConformingStrings || /e/i.test(sql[i - 1] ?? '')
      let j = i + 1
      while (j < n) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") j += 2
          else {
            j++
            break
          }
        } else if (escapeBackslashes && sql[j] === '\\' && j + 1 < n) j += 2
        else j++
      }
      cur += sql.slice(i, j)
      i = j
      continue
    }
    // Double-quoted identifier.
    if (ch === '"') {
      let j = i + 1
      while (j < n) {
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') j += 2
          else {
            j++
            break
          }
        } else {
          j++
        }
      }
      cur += sql.slice(i, j)
      i = j
      continue
    }
    // Dollar-quoted string: $$…$$ or $tag$…$tag$.
    if (ch === '$') {
      const previous = sql[i - 1]
      const tag =
        (!previous || !/[A-Za-z0-9_$]/.test(previous)) &&
        /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))
      if (tag) {
        const close = sql.indexOf(tag[0], i + tag[0].length)
        const stop = close === -1 ? n : close + tag[0].length
        cur += sql.slice(i, stop)
        i = stop
        continue
      }
      cur += ch
      i++
      continue
    }
    if (ch === ';') {
      finish()
      cur = ''
      i++
      continue
    }
    cur += ch
    i++
  }
  finish()
  return out
}
