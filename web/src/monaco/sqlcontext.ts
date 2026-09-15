// Pure SQL context helpers for hover and completion: which identifier is
// under a cursor offset, its dotted chain, and whether it is followed by `(`.
// The scanner skips strings, comments and dollar-quoted bodies (a cursor
// inside one has no identifier), while quoted identifiers become tokens so
// names like "My Col" resolve.

export interface IdentifierAt {
  /** Identifier text without surrounding quotes. */
  name: string
  /** Identifier text as written (quoted identifiers keep their quotes). */
  raw: string
  /** Offsets into the scanned text; `end` is exclusive. */
  start: number
  end: number
  /** Dotted chain the identifier belongs to, outermost first, each part as
   * written (so callers can fold it with normIdent). */
  chain: string[]
  quoted: boolean
}

interface Token {
  kind: 'ident' | 'punct'
  start: number
  end: number
  name: string
  quoted: boolean
}

function isIdentStart(ch: string): boolean {
  return /[A-Za-z_\u0080-\uffff]/.test(ch)
}

function isIdentPart(ch: string): boolean {
  return /[A-Za-z0-9_$\u0080-\uffff]/.test(ch)
}

/** Tokens of `text`; whitespace, strings, comments and dollar bodies skip. */
function tokenize(text: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  const n = text.length
  while (i < n) {
    const ch = text[i] as string
    if (/\s/.test(ch)) {
      i++
      continue
    }
    if (ch === '-' && text[i + 1] === '-') {
      const end = text.indexOf('\n', i + 2)
      i = end === -1 ? n : end
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      let depth = 1
      let j = i + 2
      while (j < n && depth > 0) {
        if (text[j] === '/' && text[j + 1] === '*') {
          depth++
          j += 2
        } else if (text[j] === '*' && text[j + 1] === '/') {
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
      const escapeBackslashes = /e/i.test(text[i - 1] ?? '')
      let j = i + 1
      while (j < n) {
        if (text[j] === "'") {
          if (text[j + 1] === "'") {
            j += 2
            continue
          }
          j++
          break
        }
        if (escapeBackslashes && text[j] === '\\' && j + 1 < n) {
          j += 2
          continue
        }
        j++
      }
      i = j
      continue
    }
    if (ch === '"') {
      let j = i + 1
      let name = ''
      while (j < n) {
        if (text[j] === '"') {
          if (text[j + 1] === '"') {
            name += '"'
            j += 2
            continue
          }
          j++
          break
        }
        name += text[j]
        j++
      }
      tokens.push({ kind: 'ident', start: i, end: j, name, quoted: true })
      i = j
      continue
    }
    if (ch === '$') {
      const previous = text[i - 1]
      const tag =
        (!previous || !/[A-Za-z0-9_$]/.test(previous)) &&
        /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i))
      if (tag) {
        const close = text.indexOf(tag[0], i + tag[0].length)
        i = close === -1 ? n : close + tag[0].length
        continue
      }
      tokens.push({ kind: 'punct', start: i, end: i + 1, name: ch, quoted: false })
      i++
      continue
    }
    if (isIdentStart(ch)) {
      let j = i + 1
      while (j < n && isIdentPart(text[j] as string)) j++
      tokens.push({ kind: 'ident', start: i, end: j, name: text.slice(i, j), quoted: false })
      i = j
      continue
    }
    tokens.push({ kind: 'punct', start: i, end: i + 1, name: ch, quoted: false })
    i++
  }
  return tokens
}

function rawOf(text: string, token: Token): string {
  return token.quoted ? text.slice(token.start, token.end) : token.name
}

/** The identifier containing `offset`, with its dotted chain, or null. */
export function identifierAt(text: string, offset: number): IdentifierAt | null {
  const tokens = tokenize(text)
  let index = -1
  for (let k = 0; k < tokens.length; k++) {
    const token = tokens[k] as Token
    if (token.kind === 'ident' && token.start <= offset && offset <= token.end) {
      index = k
      break
    }
  }
  if (index < 0) return null

  const token = tokens[index] as Token
  const chain = [rawOf(text, token)]

  let k = index - 1
  while (
    k - 1 >= 0 &&
    tokens[k]?.kind === 'punct' &&
    tokens[k]?.name === '.' &&
    tokens[k - 1]?.kind === 'ident'
  ) {
    chain.unshift(rawOf(text, tokens[k - 1] as Token))
    k -= 2
  }
  let m = index + 1
  while (
    m + 1 < tokens.length &&
    tokens[m]?.kind === 'punct' &&
    tokens[m]?.name === '.' &&
    tokens[m + 1]?.kind === 'ident'
  ) {
    chain.push(rawOf(text, tokens[m + 1] as Token))
    m += 2
  }

  return {
    name: token.name,
    raw: rawOf(text, token),
    start: token.start,
    end: token.end,
    chain,
    quoted: token.quoted,
  }
}

/** True when the first token at or after `offset` is `(`. */
export function callSite(text: string, offset: number): boolean {
  for (const token of tokenize(text)) {
    if (token.start < offset) continue
    return token.kind === 'punct' && token.name === '('
  }
  return false
}
