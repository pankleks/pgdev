// Selective Monaco imports: the full barrel pulls in every language service
// (TypeScript, CSS, HTML, JSON, ~80 basic grammars) that an SQL editor never
// uses. editor.all keeps the editor contributions (suggest widget, find,
// commands, context menu); only the SQL grammar and the editor worker are
// added on top. Verify completions, formatting and folding after touching
// this list — a missing contribution fails silently.
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api'
import 'monaco-editor/esm/vs/editor/editor.all.js'
import 'monaco-editor/esm/vs/basic-languages/sql/sql.contribution.js'
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'

;(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
}

export default monaco
