import { format } from 'sql-formatter'

const OPTS = {
  language: 'postgresql',
  tabWidth: 4,
  useTabs: true,
  keywordCase: 'upper',
  linesBetweenQueries: 2,
} as const

function formatPlain(sql: string): string {
  return format(sql, { ...OPTS })
}

interface DollarSegment {
  openStart: number
  openEnd: number
  closeStart: number
  statementStart: number
}

function dollarDelimiterAt(sql: string, index: number): string | null {
  const previous = sql[index - 1]
  if (previous && /[A-Za-z0-9_$]/.test(previous)) return null
  return /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(index))?.[0] ?? null
}

function stripComments(sql: string): string {
  return sql
    .replace(/--[^\r\n]*(?:\r?\n|$)/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
}

function findDollarSegments(sql: string): DollarSegment[] {
  const segments: DollarSegment[] = []
  let statementStart = 0
  let standardConformingStrings = true
  let i = 0
  while (i < sql.length) {
    if (sql[i] === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i + 2)
      i = end === -1 ? sql.length : end
      continue
    }
    if (sql[i] === '/' && sql[i + 1] === '*') {
      let depth = 1
      i += 2
      while (i < sql.length && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth++
          i += 2
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--
          i += 2
        } else {
          i++
        }
      }
      continue
    }
    if (sql[i] === "'") {
      const escapeBackslashes = !standardConformingStrings || /e/i.test(sql[i - 1] ?? '')
      i++
      while (i < sql.length) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") i += 2
          else {
            i++
            break
          }
        } else if (escapeBackslashes && sql[i] === '\\' && i + 1 < sql.length) {
          i += 2
        } else {
          i++
        }
      }
      continue
    }
    if (sql[i] === '"') {
      i++
      while (i < sql.length) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') i += 2
          else {
            i++
            break
          }
        } else {
          i++
        }
      }
      continue
    }
    const delimiter = sql[i] === '$' ? dollarDelimiterAt(sql, i) : null
    if (delimiter) {
      const closeStart = sql.indexOf(delimiter, i + delimiter.length)
      if (closeStart === -1) break
      segments.push({
        openStart: i,
        openEnd: i + delimiter.length,
        closeStart,
        statementStart,
      })
      i = closeStart + delimiter.length
      continue
    }
    if (sql[i] === ';') {
      const statement = sql.slice(statementStart, i)
      const setting = /\bstandard_conforming_strings\s*(?:=|TO)\s*['"]?(on|off)\b/i.exec(statement)
      if (setting) standardConformingStrings = setting[1].toLowerCase() === 'on'
      statementStart = i + 1
    }
    i++
  }
  return segments
}

// Only reformat the inside of dollar-quoted segments that belong to a
// routine body (CREATE FUNCTION/PROCEDURE … AS $tag$ … or DO … $tag$ …).
// Any other dollar-quoted literal (e.g. SELECT $$a;b$$) is left byte-for-byte
// intact — reformatting string contents would corrupt them.
function isRoutineBody(codeBefore: string): boolean {
  const code = stripComments(codeBefore).trimEnd()
  if (/CREATE\s+(OR\s+REPLACE\s+)?(FUNCTION|PROCEDURE)\b[\s\S]*\bAS\s*$/i.test(code)) return true
  return /\bDO(\s+LANGUAGE\s+[A-Za-z_][A-Za-z0-9_]*\s*)?$/i.test(code)
}

export function formatSql(sql: string): string {
  const segments = findDollarSegments(sql)
  if (!segments.length) return formatPlain(sql)
  let out = ''
  let last = 0
  for (const segment of segments) {
    // Code chunk ends with the opening delimiter (the formatter keeps it).
    const head = sql.slice(last, segment.openEnd)
    try {
      out += formatPlain(head).replace(/\s+$/, '')
    } catch {
      out += head
    }
    const body = sql.slice(segment.openEnd, segment.closeStart)
    if (body.trim() && isRoutineBody(sql.slice(segment.statementStart, segment.openStart))) {
      try {
        out += '\n' + formatPlain(body).replace(/^\s+/, '').replace(/\s+$/, '') + '\n'
      } catch {
        out += body
      }
    } else {
      out += body
    }
    // The closing delimiter starts the next code chunk.
    last = segment.closeStart
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
