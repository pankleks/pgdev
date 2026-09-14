// Formatting for the results-grid value dialog. JSON/JSONB cells arrive as
// raw server text (the server keeps them unparsed), so the formatter must be
// lossless: it copies every token verbatim and only inserts indentation.
// JSON.parse/JSON.stringify would lose precision on large integers, rewrite
// number spellings (`1.0` → `1`, `1e999` → `null`) and re-escape strings.

const JSON_TYPES = new Set(['json', 'jsonb'])

/**
 * Pretty-print JSON text with a two-space indent, or return null when the
 * text is not well-formed JSON (the caller then shows the raw value).
 * Numbers, strings and literals are never decoded — only moved.
 */
function prettyJson(text: string): string | null {
  let i = 0
  let out = ''
  let indent = 0
  const n = text.length

  const skipWhitespace = (): void => {
    while (i < n && /\s/.test(text[i] ?? '')) i++
  }

  const newline = (): void => {
    out += '\n' + '  '.repeat(indent)
  }

  const stringToken = (): boolean => {
    const start = i
    i++ // opening quote
    while (i < n) {
      const ch = text[i]
      if (ch === '\\') {
        i += 2
        continue
      }
      if (ch === '"') {
        i++
        out += text.slice(start, i)
        return true
      }
      // JSON strings cannot contain raw control characters.
      if (ch === '\n' || ch === '\r') return false
      i++
    }
    return false
  }

  const value = (): boolean => {
    skipWhitespace()
    const ch = text[i]
    if (ch === '{' || ch === '[') return container(ch)
    if (ch === '"') return stringToken()
    const match = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i))
    if (!match) return false
    out += match[0]
    i += match[0].length
    return true
  }

  const container = (open: string): boolean => {
    const close = open === '{' ? '}' : ']'
    out += open
    i++
    skipWhitespace()
    if (text[i] === close) {
      out += close
      i++
      return true
    }
    indent++
    newline()
    for (;;) {
      if (open === '{') {
        skipWhitespace()
        if (text[i] !== '"' || !stringToken()) return false
        skipWhitespace()
        if (text[i] !== ':') return false
        out += ': '
        i++
      }
      if (!value()) return false
      skipWhitespace()
      const ch = text[i]
      if (ch === ',') {
        out += ','
        i++
        newline()
        continue
      }
      if (ch === close) {
        i++
        indent--
        newline()
        out += close
        return true
      }
      return false
    }
  }

  skipWhitespace()
  if (!value()) return null
  skipWhitespace()
  if (i !== n) return null
  return out
}

/**
 * Format one result cell for display in the value dialog. JSON/JSONB values
 * arrive as raw JSON text, so a successful token-safe pass is reprinted with
 * a two-space indent; anything that does not parse — and every non-JSON type
 * — shows the raw text unchanged.
 */
export function formatCellValue(value: string, type: string): string {
  if (!JSON_TYPES.has(type) || typeof value !== 'string') return value
  return prettyJson(value) ?? value
}
