// Hover and completion text for functions, procedures and columns. Pure so
// the formatting can be unit-tested; the Monaco providers stay thin.

import type { FunctionInfo } from '../types'
import { argumentText } from './functionargs'

export interface HoverColumn {
  name: string
  type: string
  /** `schema.name`, or just the name for public relations. */
  relation: string
  nullable: boolean
  defaultValue: string | null
}

export const MAX_OVERLOADS = 5

/** Escape markdown control characters in plain text (comments, defaults). */
export function escapeMarkdown(text: string): string {
  return text.replace(/([\\`*_[\]])/g, '\\$1')
}

/** Identifiers and signatures only need the characters that could open
 * markdown syntax: an underscore inside a word (`jsonb_build_object`) cannot
 * start emphasis, so it stays readable. */
function escapeName(text: string): string {
  return text.replace(/([\\`*[\]])/g, '\\$1')
}

/** `(args) → returns` — the part after the function name (unescaped). */
export function functionSignatureDetail(f: FunctionInfo): string {
  const result = f.kind === 'procedure' || !f.returns ? '' : ` → ${f.returns}`
  return `(${argumentText(f)})${result}`
}

/** `name(args) → returns` for markdown. */
export function functionSignature(f: FunctionInfo): string {
  return `${escapeName(f.name)}${escapeName(functionSignatureDetail(f))}`
}

function overloadBlock(f: FunctionInfo): string {
  const head = `**${escapeName(f.name)}**${escapeName(functionSignatureDetail(f))}`
  const meta = `${f.kind} · ${f.schema}`
  const body = f.comment ? `\n\n${escapeMarkdown(f.comment)}` : ''
  return `${head}\n_${meta}_${body}`
}

/**
 * Documentation for signature help: kind/schema and catalog comment only. The
 * widget already draws the signature and the active parameter, so repeating it
 * here would just duplicate the top line.
 */
export function functionSignatureDoc(f: FunctionInfo): string {
  const body = f.comment ? `\n\n${escapeMarkdown(f.comment)}` : ''
  return `_${f.kind} · ${f.schema}_${body}`
}

/** Markdown for one or more overloads of a function/procedure. */
export function formatFunctionHover(functions: FunctionInfo[], max = MAX_OVERLOADS): string {
  const blocks = functions.slice(0, max).map(overloadBlock)
  if (functions.length > max) {
    blocks.push(`_+${functions.length - max} more overload(s)_`)
  }
  return blocks.join('\n\n')
}

/** Markdown for a column: type, owning relation, nullability and default. */
export function formatColumnHover(column: HoverColumn): string {
  const flags = [column.type, column.relation]
  if (!column.nullable) flags.push('not null')
  const body = column.defaultValue ? `\n\ndefault ${escapeMarkdown(column.defaultValue)}` : ''
  return `**${escapeName(column.name)}**\n_${escapeName(flags.join(' · '))}_${body}`
}
