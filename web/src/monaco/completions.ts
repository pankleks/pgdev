import type * as Monaco from 'monaco-editor'
import { useSchema } from '../composables/schema'

const KEYWORDS =
  'SELECT FROM WHERE JOIN INNER LEFT RIGHT FULL OUTER CROSS ON AS AND OR NOT NULL IS IN BETWEEN LIKE ILIKE GROUP BY ORDER HAVING LIMIT OFFSET INSERT INTO VALUES UPDATE SET DELETE RETURNING CREATE TABLE VIEW MATERIALIZED INDEX DROP ALTER ADD COLUMN AND DISTINCT CASE WHEN THEN ELSE END UNION ALL EXISTS ASC DESC WITH TRUE FALSE PRIMARY KEY FOREIGN REFERENCES CHECK DEFAULT CONSTRAINT UNIQUE CASCADE GRANT COMMENT ANALYZE EXPLAIN TRUNCATE BEGIN COMMIT ROLLBACK'

const KEYWORD_LIST = KEYWORDS.split(' ')

function qualified(schema: string, name: string): string {
  return schema === 'public' ? name : `${schema}.${name}`
}

export function registerSqlCompletion(monaco: typeof Monaco): void {
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

      const dotMatch = /([A-Za-z_][A-Za-z0-9_]*)\.$/.exec(lineBefore)
      if (dotMatch) {
        const rel = dotMatch[1].toLowerCase()
        const relations = [...(data?.tables ?? []), ...(data?.views ?? [])]
        const match = relations.find(
          (t) =>
            t.name.toLowerCase() === rel ||
            `${t.schema}.${t.name}`.toLowerCase() === rel,
        )
        for (const c of match?.columns ?? []) {
          suggestions.push({
            label: c.name,
            kind: K.Field,
            detail: c.type,
            insertText: c.name,
            range,
          })
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
      for (const f of data?.functions ?? []) {
        suggestions.push({
          label: f.name,
          kind: K.Function,
          detail: `(${f.args}) → ${f.returns}`,
          insertText: f.name,
          range,
        })
      }
      return { suggestions }
    },
  })
}
