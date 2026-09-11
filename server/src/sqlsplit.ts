// Split SQL text into individual statements on top-level semicolons.
// Aware of single-quoted strings ('' escape), double-quoted identifiers,
// line/block comments, and dollar-quoted bodies ($$…$$, $tag$…$tag$),
// so function bodies and literals containing `;` stay intact.

export function splitStatements(sql: string): string[] {
  const out: string[] = []
  let cur = ''
  let i = 0
  const n = sql.length

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
      const end = sql.indexOf('*/', i + 2)
      const stop = end === -1 ? n : end + 2
      cur += sql.slice(i, stop)
      i = stop
      continue
    }
    // Single-quoted string.
    if (ch === "'") {
      let j = i + 1
      while (j < n) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") j += 2
          else break
        } else if (sql[j] === '\\' && j + 1 < n) j += 2
        else j++
      }
      cur += sql.slice(i, Math.min(j + 1, n))
      i = Math.min(j + 1, n)
      continue
    }
    // Double-quoted identifier.
    if (ch === '"') {
      let j = i + 1
      while (j < n && sql[j] !== '"') {
        if (sql[j] === '"' && sql[j + 1] === '"') j += 2
        else j++
      }
      cur += sql.slice(i, Math.min(j + 1, n))
      i = Math.min(j + 1, n)
      continue
    }
    // Dollar-quoted string: $$…$$ or $tag$…$tag$.
    if (ch === '$') {
      const tag = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(i, i + 65))
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
      if (cur.trim()) out.push(cur.trim())
      cur = ''
      i++
      continue
    }
    cur += ch
    i++
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}
