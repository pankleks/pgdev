import type * as Monaco from 'monaco-editor'
import { useSchema } from '../composables/schema'
import type { SchemaData, TableInfo, ViewInfo } from '../types'
import {
  matchDotChain,
  findRelation,
  parseAliases,
  quoteIdent,
  splitChain,
  resolveQualifier,
} from './sqlrefs'

const KEYWORDS =
  'SELECT FROM WHERE JOIN INNER LEFT RIGHT FULL OUTER CROSS ON AS AND OR NOT NULL IS IN BETWEEN LIKE ILIKE GROUP BY ORDER HAVING LIMIT OFFSET INSERT INTO VALUES UPDATE SET DELETE RETURNING CREATE TABLE VIEW MATERIALIZED INDEX DROP ALTER ADD COLUMN DISTINCT CASE WHEN THEN ELSE END UNION INTERSECT EXCEPT ALL EXISTS ASC DESC WITH OVER PARTITION WINDOW FILTER FETCH FOR TRUE FALSE PRIMARY KEY FOREIGN REFERENCES CHECK DEFAULT CONSTRAINT UNIQUE CASCADE GRANT COMMENT ANALYZE EXPLAIN TRUNCATE BEGIN COMMIT ROLLBACK'

// Deduplicated (the old list contained AND twice).
const KEYWORD_LIST = [...new Set(KEYWORDS.split(' '))]

function qualified(schema: string, name: string): string {
  return schema === 'public' ? quoteIdent(name) : `${quoteIdent(schema)}.${quoteIdent(name)}`
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
        [K.Keyword]: 1,
        [K.Field]: 2,
        [K.Class]: 3,
      }
      const emitted = new Map<string, { item: Monaco.languages.CompletionItem; index: number }>()
      const emit = (item: Monaco.languages.CompletionItem): Monaco.languages.CompletionItem => {
        // Every label below is a plain string; normalize for the lookup key
        // because the Monaco type also allows structured labels.
        const key = typeof item.label === 'string' ? item.label : item.label.label
        const prev = emitted.get(key)
        if (!prev) {
          emitted.set(key, { item, index: suggestions.push(item) - 1 })
          return item
        }
        if ((TIER[item.kind] ?? 0) > (TIER[prev.item.kind] ?? 0)) {
          suggestions[prev.index] = item
          emitted.set(key, { item, index: prev.index })
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

      for (const t of data?.tables ?? []) {
        emit({
          label: t.name,
          kind: K.Class,
          detail: `table · ${t.schema}`,
          insertText: qualified(t.schema, t.name),
          range,
        })
      }
      for (const v of data?.views ?? []) {
        emit({
          label: v.name,
          kind: K.Class,
          detail: `${v.materialized ? 'materialized ' : ''}view · ${v.schema}`,
          insertText: qualified(v.schema, v.name),
          range,
        })
      }
      for (const t of data?.types ?? []) {
        emit({
          label: t.name,
          kind: K.Class,
          detail: `type (${t.kind}) · ${t.schema}`,
          insertText: qualified(t.schema, t.name),
          range,
        })
      }
      for (const f of data?.functions ?? []) {
        emit({
          label: f.name,
          kind: K.Function,
          detail: `(${f.args}) → ${f.returns}`,
          insertText: `${quoteIdent(f.name)}($0)`,
          insertTextRules:
            monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          range,
        })
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
