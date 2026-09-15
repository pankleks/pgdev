import { format, formatDialect, postgresql } from 'sql-formatter'
import type { DialectOptions } from 'sql-formatter'

const OPTS = {
  tabWidth: 4,
  useTabs: true,
  keywordCase: 'upper',
  linesBetweenQueries: 2,
} as const

// sql-formatter only treats names in the dialect's fixed PostgreSQL function
// list as calls, so every other name — user functions, and any schema-
// qualified name — is formatted as an identifier and gets a space before its
// parenthesis (`employee_has_any_role ($1)`). The formatter here collects the
// names the query actually calls and hands them to the dialect, so calls stay
// tight to their parenthesis. Words that legitimately keep a space (clause
// keywords like `IN (` or `VALUES (`, data types, …) are excluded.
const BUILTIN_FUNCTIONS = (postgresql.tokenizerOptions?.reservedFunctionNames ?? []) as string[]

function nonCallWords(): Set<string> {
  const keys = [
    'reservedSelect',
    'reservedClauses',
    'reservedSetOperations',
    'reservedJoins',
    'reservedKeywordPhrases',
    'reservedDataTypePhrases',
    'reservedKeywords',
    'reservedDataTypes',
  ]
  const options = postgresql.tokenizerOptions as unknown as Record<string, unknown> | undefined
  const words = new Set<string>()
  for (const key of keys) {
    const list = options?.[key]
    if (!Array.isArray(list)) continue
    for (const entry of list) {
      if (typeof entry !== 'string') continue
      for (const word of entry.split(/\s+/)) {
        if (word) words.add(word.toUpperCase())
      }
    }
  }
  return words
}

const NON_CALL_WORDS = nonCallWords()

/**
 * Index-preserving copy of `sql` where the contents of strings, comments and
 * quoted identifiers are replaced by NUL placeholders — a character none of
 * the scans below match, so a pattern can never run into masked text (a space
 * placeholder would let `[ \t]*` swallow a whole string literal). Dollar-quoted
 * bodies are deliberately left alone: a routine body is code the formatter
 * rewrites, so calls inside it must be found too.
 */
function codeMask(sql: string): string {
  const out = sql.split('')
  const n = sql.length
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < n; k++) out[k] = '\u0000'
  }

  let i = 0
  while (i < n) {
    const ch = sql[i]
    if (ch === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i + 2)
      const stop = end === -1 ? n : end
      blank(i, stop)
      i = stop
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
      blank(i, j)
      i = j
      continue
    }
    if (ch === "'") {
      const escapeBackslashes = /e/i.test(sql[i - 1] ?? '')
      let j = i + 1
      while (j < n) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2
            continue
          }
          j++
          break
        }
        if (escapeBackslashes && sql[j] === '\\' && j + 1 < n) {
          j += 2
          continue
        }
        j++
      }
      blank(i, j)
      i = j
      continue
    }
    if (ch === '"') {
      let j = i + 1
      while (j < n) {
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') {
            j += 2
            continue
          }
          j++
          break
        }
        j++
      }
      blank(i, j)
      i = j
      continue
    }
    i++
  }
  return out.join('')
}

/** Bare identifiers used as calls in code (`name(`, `name (`), keywords aside. */
function collectCallNames(sql: string): string[] {
  const mask = codeMask(sql)
  const names = new Set<string>()
  const re = /([A-Za-z_][A-Za-z0-9_$]*)[ \t]*\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(mask)) !== null) {
    const name = m[1] as string
    if (NON_CALL_WORDS.has(name.toUpperCase())) continue
    names.add(name)
  }
  return [...names]
}

/** The postgres dialect plus the names this query calls, or null when none. */
function dialectWith(callNames: string[]): DialectOptions | null {
  if (!callNames.length) return null
  return {
    ...postgresql,
    tokenizerOptions: {
      ...postgresql.tokenizerOptions,
      reservedFunctionNames: [...BUILTIN_FUNCTIONS, ...callNames],
    },
  }
}

/**
 * A schema-qualified call is always spaced (`sch.fn (x)`) because the dialect
 * turns function names after a dot into identifiers. Remove that one space
 * where the name is one of the collected calls; the mask keeps matches out of
 * strings and comments.
 */
function tightenQualifiedCalls(formatted: string, callNames: Set<string>): string {
  if (!callNames.size) return formatted
  const mask = codeMask(formatted)
  const re = /\.(\s*)([A-Za-z_][A-Za-z0-9_$]*)([ \t]+)\(/g
  let out = ''
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(mask)) !== null) {
    const name = m[2] as string
    if (!callNames.has(name)) continue
    const spaceStart = m.index + 1 + (m[1] as string).length + name.length
    out += formatted.slice(last, spaceStart)
    last = spaceStart + (m[3] as string).length
  }
  return out + formatted.slice(last)
}

/**
 * PostgreSQL JSON arrows read best tight (`bag->>'level'`), but the formatter
 * always spaces operators; strip those spaces where the arrow stands alone.
 * The mask keeps matches out of strings and comments, and the lookbehind
 * stops a match from starting inside a longer operator token.
 */
function tightenJsonArrows(formatted: string): string {
  const mask = codeMask(formatted)
  const re = /([ \t]*)(?<![->#?|&])(->>|->|#>>|#>)[ \t]*/g
  let out = ''
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(mask)) !== null) {
    out += formatted.slice(last, m.index) + (m[2] as string)
    last = m.index + m[0].length
  }
  return out + formatted.slice(last)
}

function formatPlain(sql: string, callNames: string[]): string {
  const dialect = dialectWith(callNames)
  if (dialect) return formatDialect(sql, { dialect, ...OPTS })
  return format(sql, { language: 'postgresql', ...OPTS })
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
  const callNames = collectCallNames(sql)
  const names = new Set(callNames)
  const formatChunk = (chunk: string): string =>
    tightenJsonArrows(tightenQualifiedCalls(formatPlain(chunk, callNames), names))

  const segments = findDollarSegments(sql)
  if (!segments.length) return formatChunk(sql)
  let out = ''
  let last = 0
  for (const segment of segments) {
    // Code chunk ends with the opening delimiter (the formatter keeps it).
    const head = sql.slice(last, segment.openEnd)
    try {
      out += formatChunk(head).replace(/\s+$/, '')
    } catch {
      out += head
    }
    const body = sql.slice(segment.openEnd, segment.closeStart)
    if (body.trim() && isRoutineBody(sql.slice(segment.statementStart, segment.openStart))) {
      try {
        out += '\n' + formatChunk(body).replace(/^\s+/, '').replace(/\s+$/, '') + '\n'
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
      out += formatChunk(tail).replace(/^\s+/, '')
    } catch {
      out += tail
    }
  }
  return out
}
