import type * as Monaco from 'monaco-editor'
import { useSchema } from '../composables/schema'
import type { FunctionInfo, SchemaData, TableInfo, ViewInfo } from '../types'
import { formatColumnHover, formatFunctionHover, type HoverColumn } from '../lib/hovertext'
import { callSite, identifierAt } from './sqlcontext'
import { findRelation, normIdent, parseAliases, resolveQualifier, type RelRef } from './sqlrefs'

// SQL hover: the identifier under the cursor is resolved against the loaded
// schema. At a call site (`name(`) the function/procedure is what the user is
// writing, so it wins over a same-named column; elsewhere a matching column
// wins, and a function still hovers when no column matches (e.g. its mention
// in DDL). All overloads of a name are listed with their signature, kind,
// schema and catalog comment.

type Relation = TableInfo | ViewInfo

let registered = false

/** Dev/test handle, mirroring the completion provider's. */
let devProvider: Monaco.languages.HoverProvider | null = null

function visibleRelations(relations: Relation[], aliases: Map<string, RelRef>): Relation[] {
  if (!aliases.size) return relations
  const seen = new Set<Relation>()
  for (const ref of aliases.values()) {
    const relation = findRelation(relations, ref)
    if (relation) seen.add(relation)
  }
  return [...seen]
}

function columnHover(
  relations: Relation[],
  aliases: Map<string, RelRef>,
  chain: string[],
  name: string,
): HoverColumn | null {
  const qualifier = chain.slice(0, -1)
  let relation: Relation | undefined
  if (qualifier.length) {
    relation = resolveQualifier(relations, qualifier, aliases)
    // A qualifier that names no relation (a schema, say) cannot be a column.
    if (!relation) return null
  }
  const candidates = relation ? [relation] : visibleRelations(relations, aliases)
  for (const rel of candidates) {
    const column = rel.columns.find((c) => c.name === name)
    if (!column) continue
    return {
      name: column.name,
      type: column.type,
      relation: rel.schema === 'public' ? rel.name : `${rel.schema}.${rel.name}`,
      nullable: column.nullable,
      defaultValue: column.defaultValue,
    }
  }
  return null
}

function functionHover(data: SchemaData, chain: string[], name: string): FunctionInfo[] {
  const qualifier = chain.slice(0, -1)
  const schema = qualifier.length ? normIdent(qualifier[qualifier.length - 1] as string) : ''
  // `public` first, then other schemas, catalog order within each.
  const user = (data.functions ?? [])
    .filter((f) => f.name === name && (!schema || f.schema === schema))
    .sort((a, b) => {
      const byPublic = (a.schema === 'public' ? 0 : 1) - (b.schema === 'public' ? 0 : 1)
      return byPublic || a.schema.localeCompare(b.schema) || a.oid.localeCompare(b.oid)
    })
  const builtins =
    !schema || schema === 'pg_catalog' ? (data.builtins ?? []).filter((f) => f.name === name) : []
  return [...user, ...builtins]
}

export function registerSqlHover(monaco: typeof Monaco): void {
  if (registered) return
  registered = true

  const provider: Monaco.languages.HoverProvider = {
    provideHover(model, position) {
      const { state } = useSchema()
      const data = state.data
      if (!data) return null
      const text = model.getValue()
      const ident = identifierAt(text, model.getOffsetAt(position))
      if (!ident) return null
      const name = normIdent(ident.raw)
      if (!name) return null

      const relations: Relation[] = [...data.tables, ...data.views]
      const aliases = parseAliases(text)
      const isCall = callSite(text, ident.end)
      const functions = functionHover(data, ident.chain, name)
      const column = columnHover(relations, aliases, ident.chain, name)

      const markdown =
        isCall && functions.length
          ? formatFunctionHover(functions)
          : column
            ? formatColumnHover(column)
            : functions.length
              ? formatFunctionHover(functions)
              : null
      if (!markdown) return null

      const start = model.getPositionAt(ident.start)
      const end = model.getPositionAt(ident.end)
      return {
        contents: [{ value: markdown }],
        range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
      }
    },
  }
  monaco.languages.registerHoverProvider('sql', provider)
  if (import.meta.env.DEV) devProvider = provider
}

/** Dev/test helper: the markdown the editor would show at a position. */
export function hoverContents(
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
): { markdown: string } | null {
  const result = devProvider?.provideHover(model, position, {} as never)
  // The provider contract allows a promise; ours is synchronous.
  if (!result || typeof (result as PromiseLike<unknown>).then === 'function') return null
  const hover = result as Monaco.languages.Hover
  const contents = Array.isArray(hover.contents) ? hover.contents : [hover.contents]
  return {
    markdown: contents.map((c) => (typeof c === 'string' ? c : c.value)).join('\n\n'),
  }
}
