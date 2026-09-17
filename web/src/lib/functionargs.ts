// Parser for PostgreSQL argument-list text as produced by
// `pg_get_function_arguments` (names, modes, defaults) and
// `pg_get_function_identity_arguments` (types only). Pure so it can be
// unit-tested and shared by completion, signature help and the object browser.
//
// The distinction between a named argument (`p integer`) and a type that
// merely contains a space (`double precision`) is the one genuinely tricky
// part: with no catalog access the only signal is the leading word, so a small
// set of SQL type heads is treated as "this is a type, not a name".

import type { FunctionInfo } from '../types'

export type ArgMode = 'in' | 'out' | 'inout' | 'variadic'

export interface FunctionArg {
  /** Parameter mode; defaults to `in` when unmarked. */
  mode: ArgMode
  /** Parameter name as written (quotes kept), when the signature names it. */
  name?: string
  /** Type text, without name, mode or default. */
  type: string
  /** The argument exactly as written, trimmed. */
  raw: string
  /** Offset of `raw` within the parsed text. */
  start: number
  end: number
  /** Offset of the highlightable text (the name when named, else the type). */
  labelStart: number
  labelEnd: number
  /** Highlightable text: the name when named, else the whole type. */
  label: string
}

// Leading words that introduce a type rather than a parameter name. Only
// multi-word SQL types need to appear here (`double precision`, `character
// varying`, `timestamp without time zone`); single-word types have no
// following token, so they are already read as type-only.
const TYPE_HEADS = new Set([
  'double',
  'character',
  'char',
  'varchar',
  'timestamp',
  'timestamptz',
  'time',
  'timetz',
  'bit',
  'varying',
])

/** The argument text a signature should show: named form first, identity else. */
export function argumentText(f: FunctionInfo): string {
  return f.arguments && f.arguments.length ? f.arguments : f.args
}

/** Split on top-level commas, tracking quotes and ()/[] nesting. */
function splitTopLevel(text: string): { start: number; end: number }[] {
  const parts: { start: number; end: number }[] = []
  let depth = 0
  let quote: string | null = null
  let segmentStart = 0
  let sawText = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string
    if (quote) {
      if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      sawText = true
      continue
    }
    if (!/\s/.test(ch) && ch !== ',') sawText = true
    if (ch === '(' || ch === '[') depth++
    else if (ch === ')' || ch === ']') depth--
    else if (ch === ',' && depth === 0) {
      if (sawText) parts.push({ start: segmentStart, end: i })
      segmentStart = i + 1
      sawText = false
    }
  }
  if (sawText) parts.push({ start: segmentStart, end: text.length })
  return parts
}

/** Index of the top-level `DEFAULT` keyword at or after `from`, or -1. */
function findDefault(text: string, from: number): number {
  let depth = 0
  let quote: string | null = null
  for (let i = from; i < text.length; i++) {
    const ch = text[i] as string
    if (quote) {
      if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      continue
    }
    if (ch === '(' || ch === '[') depth++
    else if (ch === ')' || ch === ']') depth--
    else if (depth === 0 && /[A-Za-z]/.test(ch) && (i === 0 || !/[A-Za-z0-9_]/.test(text[i - 1] as string))) {
      if (text.slice(i, i + 7).toUpperCase() === 'DEFAULT') return i
    }
  }
  return -1
}

function parseSegment(text: string, start: number, end: number): FunctionArg {
  const raw = text.slice(start, end)
  let i = 0
  const skipWs = (): void => {
    while (i < raw.length && /\s/.test(raw[i] as string)) i++
  }
  const absolute = (offset: number): number => start + offset

  skipWs()
  let mode: ArgMode = 'in'
  const modeMatch = /^(INOUT|IN|OUT|VARIADIC)(?=\s)/i.exec(raw.slice(i))
  if (modeMatch) {
    const after = i + modeMatch[0].length
    // A mode word is only a mode when a type follows it.
    if (raw.slice(after).trim()) {
      const word = (modeMatch[1] as string).toUpperCase()
      if (word === 'IN') {
        const out = /^\s+OUT(?=\s)/i.exec(raw.slice(after))
        if (out) {
          mode = 'inout'
          i = after + out[0].length
        } else {
          i = after
        }
      } else {
        mode = word === 'INOUT' ? 'inout' : word === 'OUT' ? 'out' : 'variadic'
        i = after
      }
    }
  }

  skipWs()
  const bodyStart = i
  const defIdx = findDefault(raw, bodyStart)
  const typePart = raw.slice(bodyStart, defIdx === -1 ? raw.length : defIdx).trimEnd()
  const typePartEnd = bodyStart + typePart.length

  // A name candidate is a lone identifier followed by whitespace: a type
  // that continues with `(` (`numeric(10, 2)`), `[` (`integer[]`) or `.`
  // (`sch.type`) never matches, so it stays a type.
  const first = /^("[^"]*"|[A-Za-z_][A-Za-z0-9_$]*)(?=\s|$)/.exec(typePart)
  if (first) {
    const word = first[0]
    const rest = typePart.slice(word.length).trim()
    const named = rest.length > 0 && !TYPE_HEADS.has(word.toLowerCase())
    if (named) {
      return {
        mode,
        name: word,
        type: rest,
        raw,
        start,
        end,
        labelStart: absolute(bodyStart),
        labelEnd: absolute(bodyStart + word.length),
        label: word,
      }
    }
  }
  return {
    mode,
    type: typePart,
    raw,
    start,
    end,
    labelStart: absolute(bodyStart),
    labelEnd: absolute(typePartEnd),
    label: typePart,
  }
}

/** Parse an argument list (`a int, OUT b text`) into ordered parameters. */
export function parseFunctionArgs(text: string): FunctionArg[] {
  return splitTopLevel(text).map(({ start, end }) => parseSegment(text, start, end))
}
