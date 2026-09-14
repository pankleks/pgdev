import type * as Monaco from 'monaco-editor'
import { useSchema } from '../composables/schema'
import type { FunctionInfo, SchemaData, TableInfo, TypeInfo, ViewInfo } from '../types'
import {
  matchDotChain,
  findRelation,
  findSchema,
  parseAliases,
  quoteIdent,
  splitChain,
  resolveQualifier,
} from './sqlrefs'

const KEYWORDS =
  'SELECT FROM WHERE JOIN INNER LEFT RIGHT FULL OUTER CROSS ON AS AND OR NOT NULL IS IN BETWEEN LIKE ILIKE GROUP BY ORDER HAVING LIMIT OFFSET INSERT INTO VALUES UPDATE SET DELETE RETURNING CREATE TABLE VIEW MATERIALIZED INDEX DROP ALTER ADD COLUMN DISTINCT CASE WHEN THEN ELSE END UNION INTERSECT EXCEPT ALL EXISTS ASC DESC WITH OVER PARTITION WINDOW FILTER FETCH FOR TRUE FALSE PRIMARY KEY FOREIGN REFERENCES CHECK DEFAULT CONSTRAINT UNIQUE CASCADE GRANT COMMENT ANALYZE EXPLAIN TRUNCATE BEGIN COMMIT ROLLBACK CALL FUNCTION PROCEDURE RETURNS LANGUAGE REPLACE'

// Deduplicated (the old list contained AND twice).
const KEYWORD_LIST = [...new Set(KEYWORDS.split(' '))]

function qualified(schema: string, name: string): string {
  return schema === 'public' ? quoteIdent(name) : `${quoteIdent(schema)}.${quoteIdent(name)}`
}

/** Signature line for a function-like object; procedures have no result. */
function functionDetail(f: FunctionInfo): string {
  // public and pg_catalog objects are callable unqualified; a non-public
  // schema is named so same-named functions stay distinguishable.
  const schema = f.schema === 'public' || f.schema === 'pg_catalog' ? '' : ` · ${f.schema}`
  if (f.kind === 'procedure') return `(${f.args}) · procedure${schema}`
  const returns = f.returns ? ` → ${f.returns}` : ''
  const suffix = f.kind === 'aggregate' ? ' · aggregate' : f.kind === 'window' ? ' · window' : ''
  return `(${f.args})${returns}${suffix}${schema}`
}

// The provider runs on every keystroke; the relations array only changes when
// a new schema load replaces the data object, so derive it once per load.
type Relation = TableInfo | ViewInfo
let relationsCache: { data: SchemaData; relations: Relation[] } | null = null

function relationsFor(data: SchemaData): Relation[] {
  if (relationsCache?.data !== data) {
    relationsCache = { data, relations: [...data.tables, ...data.views] }
  }
  return relationsCache.relations
}

let registered = false

/**
 * The registered provider, exposed in dev builds so the browser suite can ask
 * it for suggestions directly rather than scraping the Monaco suggest widget.
 */
let devProvider: Monaco.languages.CompletionItemProvider | null = null

export function registerSqlCompletion(monaco: typeof Monaco): void {
  // QueryEditor mounts once, but guard against double registration anyway
  // (duplicate providers produce duplicate suggestions).
  if (registered) return
  registered = true

  const provider: Monaco.languages.CompletionItemProvider = {
    triggerCharacters: ['.', ' '],
    provideCompletionItems(model, position) {
      const { state } = useSchema()
      const data = state.data
      const word = model.getWordUntilPosition(position)
      const range: Monaco.IRange = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      }
      const lineBefore = model.getValueInRange({
        startLineNumber: position.lineNumber,
        startColumn: 1,
        endLineNumber: position.lineNumber,
        endColumn: word.startColumn,
      })
      const K = monaco.languages.CompletionItemKind
      const suggestions: Monaco.languages.CompletionItem[] = []
      // Priority when the same label is produced twice: a real schema object
      // beats a keyword, so `name` stays a column when a column and keyword
      // share a name.
      const TIER: Partial<Record<Monaco.languages.CompletionItemKind, number>> = {
        [K.Function]: 1,
        [K.Method]: 1,
        [K.Keyword]: 1,
        [K.Field]: 2,
        [K.Class]: 3,
      }
      const emitted = new Map<string, { item: Monaco.languages.CompletionItem; index: number }>()
      const emit = (
        item: Monaco.languages.CompletionItem,
        key?: string,
      ): Monaco.languages.CompletionItem => {
        // Every label below is a plain string; normalize for the lookup key
        // because the Monaco type also allows structured labels. Functions
        // pass a composite key: overloads and same-named functions in other
        // schemas (or a function sharing a column's name) are distinct
        // suggestions, not duplicates.
        const k = key ?? (typeof item.label === 'string' ? item.label : item.label.label)
        const prev = emitted.get(k)
        if (!prev) {
          emitted.set(k, { item, index: suggestions.push(item) - 1 })
          return item
        }
        if ((TIER[item.kind] ?? 0) > (TIER[prev.item.kind] ?? 0)) {
          suggestions[prev.index] = item
          emitted.set(k, { item, index: prev.index })
          return item
        }
        return prev.item
      }
      const relations = data ? relationsFor(data) : []
      const sqlBefore = model.getValueInRange({
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      })
      const aliases = parseAliases(sqlBefore)

      // One emitter per catalog object kind, shared between the generic list
      // and the schema-qualifier list. `inSchema` suppresses re-qualification
      // when the user already typed `schema.`.
      const itemForTable = (t: TableInfo, inSchema: boolean): void => {
        emit({
          label: t.name,
          kind: K.Class,
          detail: `table · ${t.schema}`,
          insertText: inSchema ? quoteIdent(t.name) : qualified(t.schema, t.name),
          range,
        })
      }
      const itemForView = (v: ViewInfo, inSchema: boolean): void => {
        emit({
          label: v.name,
          kind: K.Class,
          detail: `${v.materialized ? 'materialized ' : ''}view · ${v.schema}`,
          insertText: inSchema ? quoteIdent(v.name) : qualified(v.schema, v.name),
          range,
        })
      }
      const itemForType = (t: TypeInfo, inSchema: boolean): void => {
        emit({
          label: t.name,
          kind: K.Class,
          detail: `type (${t.kind}) · ${t.schema}`,
          insertText: inSchema ? quoteIdent(t.name) : qualified(t.schema, t.name),
          range,
        })
      }
      const itemForFunction = (f: FunctionInfo, inSchema: boolean): void => {
        const name = inSchema ? quoteIdent(f.name) : qualified(f.schema, f.name)
        const detail = functionDetail(f)
        emit(
          {
            label: f.name,
            kind: f.kind === 'procedure' ? K.Method : K.Function,
            detail,
            insertText: `${name}($0)`,
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            range,
          },
          `${f.name}\u0000${name}\u0000${detail}`,
        )
      }
      // Built-ins are always callable unqualified (pg_catalog is implicitly in
      // the search path), so their insert text is never schema-qualified.
      const itemForBuiltin = (f: FunctionInfo): void => {
        const detail = functionDetail(f)
        const insertText = `${quoteIdent(f.name)}($0)`
        emit(
          {
            label: f.name,
            kind: K.Function,
            detail,
            insertText,
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            range,
          },
          `${f.name}\u0000${insertText}\u0000${detail}`,
        )
      }

      const chain = matchDotChain(lineBefore)
      if (chain) {
        const parts = splitChain(chain)
        const match = resolveQualifier(relations, parts, aliases)

        if (match) {
          for (const c of match.columns) {
            suggestions.push({
              label: c.name,
              kind: K.Field,
              detail: `${c.type} · ${match.schema === 'public' ? match.name : `${match.schema}.${match.name}`}`,
              insertText: quoteIdent(c.name),
              range,
            })
          }
          return { suggestions }
        }

        // Not a relation: a single trailing part may name a schema (`app.`).
        // A schema has no columns, so offer everything it holds instead.
        if (parts.length === 1 && data) {
          const schemas = [
            ...new Set([
              ...data.tables.map((o) => o.schema),
              ...data.views.map((o) => o.schema),
              ...data.types.map((o) => o.schema),
              ...data.functions.map((o) => o.schema),
            ]),
          ]
          const schema = findSchema(schemas, parts[0])
          if (schema) {
            for (const t of data.tables) if (t.schema === schema) itemForTable(t, true)
            for (const v of data.views) if (v.schema === schema) itemForView(v, true)
            for (const t of data.types) if (t.schema === schema) itemForType(t, true)
            for (const f of data.functions) if (f.schema === schema) itemForFunction(f, true)
          }
        }
        return { suggestions }
      }

      for (const kw of KEYWORD_LIST) {
        emit({ label: kw, kind: K.Keyword, insertText: kw, range })
      }

      // Offer unqualified fields from relations in the current query. When
      // no relation is known yet, fall back to the loaded schema.
      const visibleRelations = aliases.size
        ? [...new Set([...aliases.values()].flatMap((ref) => {
            const relation = findRelation(relations, ref)
            return relation ? [relation] : []
          }))]
        : relations
      // The same column name commonly exists in several relations (`id` in
      // both employees and departments). Monaco would list one row per
      // occurrence, so keep the first and name the other relations in the
      // detail line instead of repeating the entry.
      for (const relation of visibleRelations) {
        const relationName = relation.schema === 'public' ? relation.name : `${relation.schema}.${relation.name}`
        for (const c of relation.columns) {
          const winner = emit({
            label: c.name,
            kind: K.Field,
            detail: `${c.type} · ${relationName}`,
            insertText: quoteIdent(c.name),
            range,
          })
          // A duplicate column also found elsewhere: record the other relation
          // in the detail line so the single entry stays informative.
          if (winner.kind !== K.Field || suggestions.indexOf(winner) === -1) continue
          const from = String(winner.detail ?? '').replace(/^.*? · /, '')
          if (!from.split(', ').includes(relationName)) {
            winner.detail = `${c.type} · ${from}, ${relationName}`
          }
        }
      }

      for (const t of data?.tables ?? []) itemForTable(t, false)
      for (const v of data?.views ?? []) itemForView(v, false)
      for (const t of data?.types ?? []) itemForType(t, false)
      for (const f of data?.functions ?? []) itemForFunction(f, false)
      // Built-ins run into the thousands; only offer the ones the user has
      // already started to type, so the list stays focused and cheap.
      const prefix = word.word.toLowerCase()
      if (data && prefix.length >= 2) {
        for (const f of data.builtins ?? []) {
          if (f.name.toLowerCase().startsWith(prefix)) itemForBuiltin(f)
        }
      }
      return { suggestions }
    },
  }
  monaco.languages.registerCompletionItemProvider('sql', provider)
  if (import.meta.env.DEV) devProvider = provider
}

/** Dev/test helper: the suggestions the editor would receive at a position. */
export function completionSuggestions(
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
): Monaco.languages.CompletionItem[] {
  const result = devProvider?.provideCompletionItems(model, position, {} as never, {} as never)
  if (!result || Array.isArray(result) || !('suggestions' in result)) return []
  return result.suggestions
}
