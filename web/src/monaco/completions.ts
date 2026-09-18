import type * as Monaco from 'monaco-editor'
import { useSchema } from '../composables/schema'
import type { FunctionInfo, SchemaData, SequenceInfo, TableInfo, TypeInfo, ViewInfo } from '../types'
import { functionSignatureDetail } from '../lib/hovertext'
import { catalogFor, resolveRelation, visibleRelations } from '../lib/catalog'
import { callSite, identifierRangeAt } from './sqlcontext'
import { bodySymbols } from './plpgsql'
import { resolveQueryScope } from './sqlscope'
import {
  matchDotChain,
  findSchema,
  quoteIdent,
  escapeSnippet,
  splitChain,
  unquoteIdent,
  normIdent,
  relationLabel,
} from './sqlrefs'
import {
  builtinActive,
  completionMatchesPrefix,
  functionDetail,
  functionSuggestionKey,
  objectKey,
} from './completekeys'

const KEYWORDS =
  'SELECT FROM WHERE JOIN INNER LEFT RIGHT FULL OUTER CROSS ON AS AND OR NOT NULL IS IN BETWEEN LIKE ILIKE GROUP BY ORDER HAVING LIMIT OFFSET INSERT INTO VALUES UPDATE SET DELETE RETURNING CREATE TABLE VIEW MATERIALIZED INDEX DROP ALTER ADD COLUMN DISTINCT CASE WHEN THEN ELSE END UNION INTERSECT EXCEPT ALL EXISTS ASC DESC WITH OVER PARTITION WINDOW FILTER FETCH FOR TRUE FALSE PRIMARY KEY FOREIGN REFERENCES CHECK DEFAULT CONSTRAINT UNIQUE CASCADE GRANT COMMENT ANALYZE EXPLAIN TRUNCATE BEGIN COMMIT ROLLBACK CALL FUNCTION PROCEDURE RETURNS LANGUAGE REPLACE ON CONFLICT DO NOTHING EXCLUDED RECURSIVE LATERAL TABLESAMPLE ROLLUP CUBE GROUPING SETS ORDINALITY OVERRIDING GENERATED ALWAYS IDENTITY INCLUDE RANGE HASH ATTACH DETACH REFRESH CONCURRENTLY VALIDATE RENAME OWNER SCHEMA DATABASE EXTENSION SERIALIZABLE DEFERRABLE DEFERRED IMMEDIATE SAVEPOINT RELEASE ABORT VACUUM REINDEX CLUSTER COPY STDIN LOCK SHARE NOWAIT SKIP LOCKED'

// Deduplicated (the old list contained AND twice).
const KEYWORD_LIST = [...new Set(KEYWORDS.split(' '))]

// Common built-in types offered after a `::` cast. User-defined types still
// come from the catalog; this list covers the scalar types people reach for.
const BUILTIN_TYPES =
  'bigint bigserial bit boolean box bytea char character cidr circle date decimal double precision inet integer interval json jsonb line lseg macaddr macaddr8 money numeric oid path pg_lsn point polygon real serial smallint smallserial text time timetz timestamp timestamptz tsquery tsvector uuid varbit varchar xml'.split(
    ' ',
  )

/** Fallback catalog before a connection loads; synthetic refs still resolve. */
const EMPTY_SCHEMA: SchemaData = { tables: [], views: [], types: [], functions: [], sequences: [], builtins: [] }

function qualified(schema: string, name: string): string {
  return schema === 'public' ? quoteIdent(name) : `${quoteIdent(schema)}.${quoteIdent(name)}`
}

// Schema lookups come from the shared catalog index (lib/catalog.ts), rebuilt
// only when a new schema load replaces the data object. Synthetic CTE/derived
// relations from the current query join it per request.

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
      const text = model.getValue()
      const offset = model.getOffsetAt(position)
      // Replace the whole SQL identifier, quotes included, rather than Monaco's
      // word: accepting a suggestion for `"My` must not leave the quote behind.
      const span = identifierRangeAt(text, offset)
      const start = span ? model.getPositionAt(span.start) : position
      const end = span ? model.getPositionAt(span.end) : position
      const range: Monaco.IRange = {
        startLineNumber: start.lineNumber,
        startColumn: start.column,
        endLineNumber: end.lineNumber,
        endColumn: end.column,
      }
      // The qualifier sits immediately before the identifier, so a partially
      // typed quoted name (`app."My`) still resolves the `app` prefix.
      const beforeStart = span ? span.start : offset
      const lineStart = text.lastIndexOf('\n', beforeStart - 1) + 1
      const lineBefore = text.slice(lineStart, beforeStart)
      const identEnd = span ? span.end : offset
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
        [K.Variable]: 4,
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
      // Monaco fuzzy-filters every suggestion against the word being typed,
      // so allocating items that could never pass is pure per-keystroke cost
      // on a large schema. Gate candidates with the same rule Monaco applies
      // (see completekeys.ts); an empty prefix passes everything.
      const prefix = word.word.toLowerCase()
      const matchesPrefix = (label: string): boolean => completionMatchesPrefix(prefix, label)
      const scope = resolveQueryScope(text, offset)
      const { aliases } = scope
      const synthetic = scope.relations
      const catalog = catalogFor(data ?? EMPTY_SCHEMA)
      // A word directly followed by `(` is being called: rank functions above
      // same-named columns there, and describe both inline so the identical
      // labels stay distinguishable.
      const atCall = callSite(text, identEnd)
      const callSort = atCall ? '0' : undefined

      // Inside a dollar-quoted routine body the function's parameters and its
      // DECLARE variables are the most local names; offer them first.
      const symbols = bodySymbols(text, offset)
      for (const sym of symbols) {
        const ident = unquoteIdent(sym.name)
        if (!matchesPrefix(ident)) continue
        const detail = sym.kind === 'param'
          ? `${sym.mode} parameter${sym.type ? ` · ${sym.type}` : ''}`
          : `variable${sym.type ? ` · ${sym.type}` : ''}`
        emit({
          label: ident,
          kind: K.Variable,
          detail,
          insertText: quoteIdent(ident),
          range,
          sortText: '0',
        })
      }

      // One emitter per catalog object kind, shared between the generic list
      // and the schema-qualifier list. `inSchema` suppresses re-qualification
      // when the user already typed `schema.` (dedup keys live in
      // completekeys.ts so same-named objects in other schemas survive).
      const itemForTable = (t: TableInfo, inSchema: boolean): void => {
        if (!matchesPrefix(t.name)) return
        emit(
          {
            label: t.name,
            kind: K.Class,
            detail: `table · ${t.schema}`,
            insertText: inSchema ? quoteIdent(t.name) : qualified(t.schema, t.name),
            range,
          },
          objectKey('table', t.schema, t.name),
        )
      }
      const itemForView = (v: ViewInfo, inSchema: boolean): void => {
        if (!matchesPrefix(v.name)) return
        emit(
          {
            label: v.name,
            kind: K.Class,
            detail: `${v.materialized ? 'materialized ' : ''}view · ${v.schema}`,
            insertText: inSchema ? quoteIdent(v.name) : qualified(v.schema, v.name),
            range,
          },
          objectKey(v.materialized ? 'matview' : 'view', v.schema, v.name),
        )
      }
      const itemForType = (t: TypeInfo, inSchema: boolean): void => {
        if (!matchesPrefix(t.name)) return
        emit(
          {
            label: t.name,
            kind: K.Class,
            detail: `type (${t.kind}) · ${t.schema}`,
            insertText: inSchema ? quoteIdent(t.name) : qualified(t.schema, t.name),
            range,
          },
          objectKey('type', t.schema, t.name),
        )
      }
      const itemForSequence = (s: SequenceInfo, inSchema: boolean): void => {
        if (!matchesPrefix(s.name)) return
        emit(
          {
            label: s.name,
            kind: K.Class,
            detail: `sequence · ${s.schema}`,
            insertText: inSchema ? quoteIdent(s.name) : qualified(s.schema, s.name),
            range,
          },
          objectKey('sequence', s.schema, s.name),
        )
      }
      const itemForFunction = (f: FunctionInfo, inSchema: boolean): void => {
        if (!matchesPrefix(f.name)) return
        const name = inSchema ? quoteIdent(f.name) : qualified(f.schema, f.name)
        const detail = functionDetail(f)
        emit(
          {
            label: { label: f.name, description: functionSignatureDetail(f) },
            kind: f.kind === 'procedure' ? K.Method : K.Function,
            detail,
            // A name containing `$` must not be read as snippet syntax.
            insertText: `${escapeSnippet(name)}($0)`,
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            range,
            sortText: callSort,
          },
          functionSuggestionKey(f.name, name, detail),
        )
      }
      // Built-ins are always callable unqualified (pg_catalog is implicitly in
      // the search path), so their insert text is never schema-qualified.
      const itemForBuiltin = (f: FunctionInfo): void => {
        if (!matchesPrefix(f.name)) return
        const detail = functionDetail(f)
        const insertText = `${escapeSnippet(quoteIdent(f.name))}($0)`
        emit(
          {
            label: { label: f.name, description: functionSignatureDetail(f) },
            kind: K.Function,
            detail,
            insertText,
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            range,
            sortText: callSort,
          },
          functionSuggestionKey(f.name, insertText, detail),
        )
      }

      // Three inline columns: name | type | relation. Monaco renders the
      // label detail flush against the description, so the relation carries
      // its own leading separator (the outer detail keeps the combined
      // string for the focused-row detail pane).
      const columnLabel = (
        name: string,
        type: string,
        relations: string,
      ): Pick<Monaco.languages.CompletionItem, 'label' | 'detail'> => ({
        label: { label: name, description: type, detail: ` · ${relations}` },
        detail: `${type} · ${relations}`,
      })

      const chain = matchDotChain(lineBefore)
      if (chain) {
        const parts = splitChain(chain)
        const match = resolveRelation(catalog, synthetic, parts, aliases)

        if (match) {
          const relationName = relationLabel(match)
          for (const c of match.columns) {
            if (!matchesPrefix(c.name)) continue
            suggestions.push({
              ...columnLabel(c.name, c.type, relationName),
              kind: K.Field,
              insertText: quoteIdent(c.name),
              range,
            })
          }
          return { suggestions }
        }

        // Not a relation: a single trailing part may name a schema (`app.`).
        // A schema has no columns, so offer everything it holds instead.
        if (parts.length === 1 && data && !aliases.has(normIdent(parts[0]!))) {
          const schema = findSchema(catalog.schemas, parts[0])
          const objects = schema ? catalog.bySchema.get(schema) : undefined
          if (objects) {
            for (const t of objects.tables) itemForTable(t, true)
            for (const v of objects.views) itemForView(v, true)
            for (const t of objects.types) itemForType(t, true)
            for (const s of objects.sequences) itemForSequence(s, true)
            for (const f of objects.functions) itemForFunction(f, true)
          }
        }
        return { suggestions }
      }

      // After `::` the user is naming a type; offer the common built-ins and
      // stop there rather than mixing in tables, columns and functions.
      if (/::\s*[A-Za-z_]*$/.test(lineBefore)) {
        for (const name of BUILTIN_TYPES) {
          if (!matchesPrefix(name)) continue
          emit({
            label: name,
            kind: K.Class,
            detail: 'built-in type',
            insertText: name,
            range,
          })
        }
        return { suggestions }
      }

      for (const kw of KEYWORD_LIST) {
        if (!matchesPrefix(kw.toLowerCase())) continue
        emit({ label: kw, kind: K.Keyword, insertText: kw, range })
      }

      // Offer unqualified fields from relations in the current query. When
      // no relation is known yet, fall back to the loaded schema.
      const visible = visibleRelations(catalog, synthetic, scope)
      // The same column name commonly exists in several relations (`id` in
      // both employees and departments). Monaco would list one row per
      // occurrence, so keep the first and name the other relations in the
      // relation column instead of repeating the entry. Occurrences accumulate
      // into per-column sets, and each merged row is formatted once
      // afterwards — re-splitting a growing label per occurrence used
      // to make common column names quadratic.
      const columnSources = new Map<string, { type: string; relations: string[] }>()
      for (const relation of visible) {
        const relationName = relationLabel(relation)
        for (const c of relation.columns) {
          if (!matchesPrefix(c.name)) continue
          const hit = columnSources.get(c.name)
          if (!hit) {
            columnSources.set(c.name, { type: c.type, relations: [relationName] })
            emit({
              ...columnLabel(c.name, c.type, relationName),
              kind: K.Field,
              insertText: quoteIdent(c.name),
              range,
            })
          } else {
            hit.relations.push(relationName)
          }
        }
      }
      // Format each merged row once, after the accumulation pass: the
      // survivor comes from `emit` (the map's surviving entry), so an entry a
      // same-named table took over is left alone.
      for (const [key, hit] of columnSources) {
        if (hit.relations.length <= 1) continue
        const survivor = emitted.get(key)?.item
        if (!survivor || survivor.kind !== K.Field) continue
        const cols = columnLabel(
          typeof survivor.label === 'string' ? survivor.label : survivor.label.label,
          hit.type,
          hit.relations.join(', '),
        )
        survivor.detail = cols.detail
        survivor.label = cols.label
      }

      for (const t of data?.tables ?? []) itemForTable(t, false)
      for (const v of data?.views ?? []) itemForView(v, false)
      for (const t of data?.types ?? []) itemForType(t, false)
      for (const s of data?.sequences ?? []) itemForSequence(s, false)
      for (const f of data?.functions ?? []) itemForFunction(f, false)
      // Built-ins run into the thousands; only offer the ones the user has
      // already started to type, so the list stays focused and cheap.
      if (data && builtinActive(prefix)) {
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
