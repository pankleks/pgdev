import type * as Monaco from 'monaco-editor'
import { useSchema } from '../composables/schema'
import {
  matchDotChain,
  normIdent,
  parseAliases,
  quoteIdent,
  splitChain,
  type RelRef,
} from './sqlrefs'

const KEYWORDS =
  'SELECT FROM WHERE JOIN INNER LEFT RIGHT FULL OUTER CROSS ON AS AND OR NOT NULL IS IN BETWEEN LIKE ILIKE GROUP BY ORDER HAVING LIMIT OFFSET INSERT INTO VALUES UPDATE SET DELETE RETURNING CREATE TABLE VIEW MATERIALIZED INDEX DROP ALTER ADD COLUMN DISTINCT CASE WHEN THEN ELSE END UNION INTERSECT EXCEPT ALL EXISTS ASC DESC WITH OVER PARTITION WINDOW FILTER FETCH FOR TRUE FALSE PRIMARY KEY FOREIGN REFERENCES CHECK DEFAULT CONSTRAINT UNIQUE CASCADE GRANT COMMENT ANALYZE EXPLAIN TRUNCATE BEGIN COMMIT ROLLBACK'

// Deduplicated (the old list contained AND twice).
const KEYWORD_LIST = [...new Set(KEYWORDS.split(' '))]

function qualified(schema: string, name: string): string {
  return schema === 'public' ? quoteIdent(name) : `${quoteIdent(schema)}.${quoteIdent(name)}`
}

let registered = false

export function registerSqlCompletion(monaco: typeof Monaco): void {
  // QueryEditor mounts once, but guard against double registration anyway
  // (duplicate providers produce duplicate suggestions).
  if (registered) return
  registered = true

  monaco.languages.registerCompletionItemProvider('sql', {
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

      const chain = matchDotChain(lineBefore)
      if (chain) {
        const parts = splitChain(chain)
        const relations = [...(data?.tables ?? []), ...(data?.views ?? [])]
        const findRel = (ref: RelRef) =>
          relations.find((t) => {
            if (ref.schema) {
              return (
                t.schema.toLowerCase() === ref.schema && t.name.toLowerCase() === ref.name
              )
            }
            return t.name.toLowerCase() === ref.name
          }) ??
          // Prefer `public` when several schemas expose the same name.
          relations.find(
            (t) => t.name.toLowerCase() === ref.name && t.schema === 'public',
          )

        let match = null as null | (typeof relations)[number]
        if (parts.length === 1) {
          const key = normIdent(parts[0])
          // 1. table alias (`FROM employees e` → `e.`)
          const sqlBefore = model.getValueInRange({
            startLineNumber: 1,
            startColumn: 1,
            endLineNumber: position.lineNumber,
            endColumn: position.column,
          })
          const target = parseAliases(sqlBefore).get(key)
          if (target) match = findRel(target) ?? null
          // 2. bare table / view name
          if (!match) match = findRel({ schema: '', name: key }) ?? null
        } else {
          // schema-qualified (`sch.tbl.`); tolerate db.schema.table chains.
          const rel = normIdent(parts[parts.length - 1])
          const sch = normIdent(parts[parts.length - 2])
          match = findRel({ schema: sch, name: rel }) ?? null
        }

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
        suggestions.push({ label: kw, kind: K.Keyword, insertText: kw, range })
      }
      for (const t of data?.tables ?? []) {
        suggestions.push({
          label: t.name,
          kind: K.Class,
          detail: `table · ${t.schema}`,
          insertText: qualified(t.schema, t.name),
          range,
        })
      }
      for (const v of data?.views ?? []) {
        suggestions.push({
          label: v.name,
          kind: K.Class,
          detail: `${v.materialized ? 'materialized ' : ''}view · ${v.schema}`,
          insertText: qualified(v.schema, v.name),
          range,
        })
      }
      for (const t of data?.types ?? []) {
        suggestions.push({
          label: t.name,
          kind: K.Class,
          detail: `type (${t.kind}) · ${t.schema}`,
          insertText: qualified(t.schema, t.name),
          range,
        })
      }
      for (const f of data?.functions ?? []) {
        suggestions.push({
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
  })
}
