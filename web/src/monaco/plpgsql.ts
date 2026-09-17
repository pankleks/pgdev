// PL/pgSQL body awareness for completion: when the cursor sits inside a
// dollar-quoted routine body, recover the routine's IN/OUT/INOUT parameters
// from the CREATE FUNCTION/PROCEDURE header and the names declared in the
// body's DECLARE block. Pure (uses the shared lexer) so it is unit-testable.

import { scanSqlLexemes } from '../../../server/src/sqllex'
import { parseFunctionArgs, type ArgMode, type FunctionArg } from '../lib/functionargs'

export interface RoutineBody {
  /** Text before the opening dollar delimiter (the routine header). */
  before: string
  /** Body content between the dollar delimiters. */
  inner: string
  /** Offset of `inner` within the full document. */
  innerStart: number
  open: number
  close: number
}

export interface RoutineHeader {
  kind: 'function' | 'procedure'
  /** Schema-qualified parts as written, outermost first. */
  chain: string[]
  params: FunctionArg[]
}

export interface BodySymbol {
  /** Name as written (quotes kept). */
  name: string
  kind: 'param' | 'variable'
  mode: ArgMode
  type: string
}

interface LexToken {
  kind: 'ident' | 'punct'
  start: number
  end: number
  raw: string
  name: string
  quoted: boolean
}

function lexTokens(text: string): LexToken[] {
  const tokens: LexToken[] = []
  scanSqlLexemes(text, (lex) => {
    if (lex.kind === 'ident' || lex.kind === 'punct') {
      tokens.push({
        kind: lex.kind,
        start: lex.start,
        end: lex.end,
        raw: lex.raw,
        name: lex.name,
        quoted: lex.quoted,
      })
    }
  })
  return tokens
}

/** The dollar-quoted body containing `offset`, or null when outside one. */
export function enclosingRoutineBody(text: string, offset: number): RoutineBody | null {
  let found: RoutineBody | null = null
  scanSqlLexemes(text, (lex) => {
    if (lex.start >= offset) return false
    if (lex.kind === 'dollar' && lex.start < offset && offset < lex.end) {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(lex.raw)
      const tagLen = tag ? tag[0].length : 2
      const closed = lex.raw.length > tagLen * 2 && lex.raw.endsWith(tag ? tag[0] : '$$')
      found = {
        before: text.slice(0, lex.start),
        inner: closed ? lex.raw.slice(tagLen, lex.raw.length - tagLen) : lex.raw.slice(tagLen),
        innerStart: lex.start + tagLen,
        open: lex.start,
        close: lex.end,
      }
      return false
    }
  })
  return found
}

/**
 * Parse `[CREATE [OR REPLACE]] FUNCTION|PROCEDURE [schema.]name (…)` from the
 * text before a body. The parameter paren is the one immediately after the
 * name, so `RETURNS TABLE(…)` cannot be mistaken for it.
 */
export function parseRoutineHeader(before: string): RoutineHeader | null {
  const tokens = lexTokens(before)
  let keyword = -1
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i] as LexToken
    if (t.kind !== 'ident' || t.quoted) continue
    const upper = t.name.toUpperCase()
    if (upper === 'FUNCTION' || upper === 'PROCEDURE') {
      keyword = i
      break
    }
  }
  if (keyword < 0) return null
  const kind = (tokens[keyword] as LexToken).name.toUpperCase() === 'PROCEDURE' ? 'procedure' : 'function'

  let j = keyword + 1
  const chain: string[] = []
  if (tokens[j]?.kind === 'ident') {
    chain.push((tokens[j] as LexToken).raw)
    j++
  }
  while (
    tokens[j]?.kind === 'punct' &&
    (tokens[j] as LexToken).raw === '.' &&
    tokens[j + 1]?.kind === 'ident'
  ) {
    chain.push((tokens[j + 1] as LexToken).raw)
    j += 2
  }
  if (!chain.length) return null

  let params: FunctionArg[] = []
  if (tokens[j]?.kind === 'punct' && (tokens[j] as LexToken).raw === '(') {
    const open = j
    let depth = 0
    let k = open
    for (; k < tokens.length; k++) {
      const t = tokens[k] as LexToken
      if (t.kind !== 'punct') continue
      if (t.raw === '(') depth++
      else if (t.raw === ')') {
        depth--
        if (depth === 0) break
      }
    }
    if (k < tokens.length) {
      params = parseFunctionArgs(before.slice((tokens[open] as LexToken).end, (tokens[k] as LexToken).start))
    }
  }
  return { kind, chain, params }
}

/**
 * Names declared in the body's DECLARE block (before the first BEGIN).
 * Each declaration starts with its name, so the first identifier is the one
 * to complete; `CONSTANT`, defaults and the like are ignored.
 */
export function parseDeclareVariables(inner: string): { name: string; type: string }[] {
  const tokens = lexTokens(inner)
  let start = -1
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as LexToken
    if (t.kind === 'ident' && !t.quoted && t.name.toUpperCase() === 'DECLARE') {
      start = i + 1
      break
    }
  }
  if (start < 0) return []

  const out: { name: string; type: string }[] = []
  const flush = (from: number, to: number): void => {
    if (from >= to) return
    const first = tokens[from] as LexToken
    if (first.kind !== 'ident') return
    let stop = (tokens[to - 1] as LexToken).end
    for (let i = from + 1; i < to; i++) {
      const t = tokens[i] as LexToken
      // The lexer splits `:=` into `:` and `=`.
      const isAssign = t.kind === 'punct' && t.raw === ':' && (tokens[i + 1] as LexToken | undefined)?.raw === '='
      const isDefault = t.kind === 'ident' && !t.quoted && t.name.toUpperCase() === 'DEFAULT'
      if (isAssign || isDefault) {
        stop = t.start
        break
      }
    }
    out.push({ name: first.raw, type: inner.slice(first.end, stop).trim() })
  }

  let segmentStart = start
  for (let i = start; i < tokens.length; i++) {
    const t = tokens[i] as LexToken
    if (t.kind === 'ident' && !t.quoted && t.name.toUpperCase() === 'BEGIN') {
      flush(segmentStart, i)
      return out
    }
    if (t.kind === 'punct' && t.raw === ';') {
      flush(segmentStart, i)
      segmentStart = i + 1
    }
  }
  return out
}

/** Parameters and DECLARE variables in scope at `offset`, or none. */
export function bodySymbols(text: string, offset: number): BodySymbol[] {
  const body = enclosingRoutineBody(text, offset)
  if (!body) return []
  const symbols: BodySymbol[] = []
  const header = parseRoutineHeader(body.before)
  for (const p of header?.params ?? []) {
    if (p.name) symbols.push({ name: p.name, kind: 'param', mode: p.mode, type: p.type })
  }
  for (const v of parseDeclareVariables(body.inner)) {
    symbols.push({ name: v.name, kind: 'variable', mode: 'in', type: v.type })
  }
  return symbols
}
