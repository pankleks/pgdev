// Selective Monaco imports: the full barrel pulls in every language service
// (TypeScript, CSS, HTML, JSON, ~80 basic grammars) that an SQL editor never
// uses. editor.all keeps the editor contributions (suggest widget, find,
// commands, context menu); only the SQL grammar and the editor worker are
// added on top. Verify completions, formatting and folding after touching
// this list — a missing contribution fails silently.
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api'
import type * as Monaco from 'monaco-editor'
import 'monaco-editor/esm/vs/editor/editor.all.js'
import 'monaco-editor/esm/vs/basic-languages/sql/sql.contribution.js'
import { language as sqlGrammar } from 'monaco-editor/esm/vs/basic-languages/sql/sql.js'
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'

;(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
}

// A word directly followed by `(` that is neither a keyword nor an operator is
// a function call: tokenize it separately so calls stand out from column and
// table names. The rule must sit before the generic word rule, and its `cases`
// keep language constructs (`IN (`, `VALUES (`, `OVER (`, …) coloured as
// before. The exported grammar object is mutated, so the lazy language loader
// registers this same, extended definition.
{
  const root = sqlGrammar.tokenizer.root
  const wordRule = root.findIndex(
    (rule) => Array.isArray(rule) && rule[0] instanceof RegExp && rule[0].source === '[\\w@#$]+',
  )
  if (wordRule >= 0) {
    const callRule = [
      /[\w@#$]+(?=\s*\()/,
      {
        cases: {
          '@keywords': 'keyword',
          '@operators': 'operator',
          '@builtinVariables': 'predefined',
          '@default': 'function',
        },
      },
    ] as Monaco.languages.IMonarchLanguageRule
    root.splice(wordRule, 0, callRule)
  }
  monaco.languages.setMonarchTokensProvider('sql', sqlGrammar)
}

// The bundled SQL grammar files `UPDATE` — and other SQL Server spellings like
// COUNT or GETDATE — under its built-in functions, and `vs-dark` paints that
// token pure magenta; it also paints every string literal pure red. This
// derived theme keeps the familiar vs-dark palette but reads those two tokens
// as a keyword and a muted string, so `UPDATE` matches `SELECT` and `'p'` no
// longer shouts. Function calls get the usual function yellow.
monaco.editor.defineTheme('pgdev-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'predefined.sql', foreground: '569CD6' },
    { token: 'string.sql', foreground: 'CE9178' },
    { token: 'function.sql', foreground: 'DCDCAA' },
  ],
  colors: {},
})

export default monaco
