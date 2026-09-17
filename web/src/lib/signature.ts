// Signature-help logic: find the call the cursor is inside, count the active
// parameter, and build the signature blocks. Pure (imports only the shared
// lexer and plain helpers) so it can be unit-tested without Monaco; the
// provider in monaco/signature.ts stays thin.

import { scanSqlLexemes } from '../../../server/src/sqllex'
import type { FunctionInfo, SchemaData } from '../types'
import { argumentText, parseFunctionArgs } from './functionargs'
import { functionSignatureDoc } from './hovertext'
import { findFunctions } from './sqlobjects'
import { normIdent } from '../monaco/sqlrefs'

export interface OpenCall {
  /** Offset of the unmatched `(` that opens the call. */
  open: number
  /** Callee dotted chain, outermost first, each part as written. */
  chain: string[]
}

export interface SignatureParameter {
  /** [start, end] offsets into the signature `label`. */
  label: [number, number]
}

export interface SignatureItem {
  label: string
  /** Markdown object so Monaco renders it instead of showing raw `**`/`_`. */
  documentation: { value: string }
  parameters: SignatureParameter[]
}

export interface SignatureHelpData {
  signatures: SignatureItem[]
  activeSignature: number
  activeParameter: number
}

interface Token {
  kind: 'ident' | 'punct'
  start: number
  end: number
  raw: string
}

// Tokenize only up to `offset`; stop at an opaque lexeme that contains the
// offset (string, comment, dollar body), since nothing after it can be part of
// the call being typed.
function tokensUpTo(text: string, offset: number): Token[] {
  const tokens: Token[] = []
  scanSqlLexemes(text, (lex) => {
    if (lex.start >= offset) return false
    if (lex.kind === 'ident' || lex.kind === 'punct') {
      tokens.push({ kind: lex.kind, start: lex.start, end: lex.end, raw: lex.raw })
      return
    }
    // Keep scanning past opaque lexemes that end before the cursor; an opaque
    // lexeme spanning it means the cursor is inside a string/comment/body.
    return lex.end <= offset
  })
  return tokens
}

/** The dollar-quoted body containing `offset`, rebased onto its inner text. */
function dollarInner(text: string, offset: number): { text: string; offset: number } | null {
  let found: { text: string; offset: number } | null = null
  scanSqlLexemes(text, (lex) => {
    if (lex.start >= offset) return false
    if (lex.kind === 'dollar' && lex.start < offset && offset < lex.end) {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(lex.raw)
      const tagLen = tag ? tag[0].length : 2
      found = { text: lex.raw.slice(tagLen), offset: offset - lex.start - tagLen }
      return false
    }
  })
  return found
}

/**
 * Signature help must look inside a dollar-quoted body (`$$…$$`): the shared
 * lexer treats the whole body as one opaque token, so a call typed in a
 * function's DDL body would otherwise be invisible. Rebase the offset onto the
 * innermost body (a few levels covers nested bodies).
 */
function signatureSource(text: string, offset: number): { text: string; offset: number } {
  for (let depth = 0; depth < 4; depth++) {
    const inner = dollarInner(text, offset)
    if (!inner) break
    text = inner.text
    offset = inner.offset
  }
  return { text, offset }
}

/** The dotted chain immediately before token index `i`, outermost first. */
function chainBefore(tokens: Token[], i: number): string[] {
  const chain: string[] = []
  let j = i - 1
  if (j < 0 || tokens[j]?.kind !== 'ident') return chain
  chain.unshift((tokens[j] as Token).raw)
  j--
  while (
    j - 1 >= 0 &&
    tokens[j]?.kind === 'punct' &&
    (tokens[j] as Token).raw === '.' &&
    tokens[j - 1]?.kind === 'ident'
  ) {
    chain.unshift((tokens[j - 1] as Token).raw)
    j -= 2
  }
  return chain
}

/** The innermost call whose `(` precedes `offset`, or null. */
export function findCall(text: string, offset: number): OpenCall | null {
  const tokens = tokensUpTo(text, offset)
  const stack: OpenCall[] = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as Token
    if (token.kind !== 'punct') continue
    if (token.raw === '(') {
      stack.push({ open: token.start, chain: chainBefore(tokens, i) })
    } else if (token.raw === ')') {
      stack.pop()
    }
  }
  // Grouping parens carry no callee; the nearest one with a chain is the call.
  for (let s = stack.length - 1; s >= 0; s--) {
    if ((stack[s] as OpenCall).chain.length) return stack[s] as OpenCall
  }
  return null
}

/** Number of top-level commas between the call's `(` and `offset`. */
export function activeParameter(text: string, open: number, offset: number): number {
  let depth = 1
  let count = 0
  for (const token of tokensUpTo(text, offset)) {
    if (token.start <= open || token.kind !== 'punct') continue
    if (token.raw === '(') depth++
    else if (token.raw === ')') {
      depth--
      if (depth === 0) break
    } else if (token.raw === ',' && depth === 1) count++
  }
  return count
}

function signatureFor(name: string, f: FunctionInfo): SignatureItem {
  const args = argumentText(f)
  const prefix = `${name}(`
  const parameters = parseFunctionArgs(args).map((a): SignatureParameter => ({
    label: [prefix.length + a.labelStart, prefix.length + a.labelEnd],
  }))
  return {
    label: `${prefix}${args})`,
    documentation: { value: functionSignatureDoc(f) },
    parameters,
  }
}

/** Signature blocks for the call under the cursor, or null when not in one. */
export function computeSignatureHelp(
  data: SchemaData,
  text: string,
  offset: number,
): SignatureHelpData | null {
  const source = signatureSource(text, offset)
  const call = findCall(source.text, source.offset)
  if (!call) return null
  const name = normIdent(call.chain[call.chain.length - 1] as string)
  const functions = findFunctions(data, call.chain, name)
  if (!functions.length) return null

  const signatures = functions.map((f) => signatureFor(name, f))
  const maxArgs = signatures[0]?.parameters.length ?? 0
  const active = activeParameter(source.text, call.open, source.offset)
  return {
    signatures,
    activeSignature: 0,
    // Beyond the last parameter (a trailing comma, say) the last one stays
    // highlighted, matching most editors.
    activeParameter: maxArgs > 0 ? Math.min(active, maxArgs - 1) : 0,
  }
}
