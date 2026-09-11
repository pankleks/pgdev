import { format } from 'sql-formatter'

const OPTS = {
  language: 'postgresql',
  tabWidth: 2,
  keywordCase: 'upper',
  linesBetweenQueries: 2,
} as const

function formatPlain(sql: string): string {
  return format(sql, { ...OPTS })
}

// `$tag$ … $tag$` (or `$$ … $$`) segments.
const DOLLAR_BODY_RE = /(\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$)([\s\S]*?)\1/g

// Only reformat the inside of dollar-quoted segments that belong to a
// routine body (CREATE FUNCTION/PROCEDURE … AS $tag$ … or DO … $tag$ …).
// Any other dollar-quoted literal (e.g. SELECT $$a;b$$) is left byte-for-byte
// intact — reformatting string contents would corrupt them.
function isRoutineBody(codeBefore: string): boolean {
  if (/CREATE\s+(OR\s+REPLACE\s+)?(FUNCTION|PROCEDURE)\b/i.test(codeBefore)) return true
  return /\bDO(\s+LANGUAGE\s+[A-Za-z_][A-Za-z0-9_]*\s*)?$/i.test(codeBefore.trimEnd())
}

export function formatSql(sql: string): string {
  DOLLAR_BODY_RE.lastIndex = 0
  if (!DOLLAR_BODY_RE.test(sql)) return formatPlain(sql)
  DOLLAR_BODY_RE.lastIndex = 0
  let out = ''
  let last = 0
  let m: RegExpExecArray | null
  while ((m = DOLLAR_BODY_RE.exec(sql)) !== null) {
    const open = m[1]
    const inner = m[2]
    // Code chunk ends with the opening delimiter (the formatter keeps it).
    const head = sql.slice(last, m.index) + open
    try {
      out += formatPlain(head).replace(/\s+$/, '')
    } catch {
      out += head
    }
    if (inner.trim() && isRoutineBody(sql.slice(0, m.index))) {
      try {
        out += '\n' + formatPlain(inner).replace(/^\s+/, '').replace(/\s+$/, '') + '\n'
      } catch {
        out += inner
      }
    } else {
      out += inner
    }
    // The closing delimiter starts the next code chunk.
    last = m.index + m[0].length - open.length
  }
  const tail = sql.slice(last)
  if (tail.trim()) {
    try {
      out += formatPlain(tail).replace(/^\s+/, '')
    } catch {
      out += tail
    }
  }
  return out
}
