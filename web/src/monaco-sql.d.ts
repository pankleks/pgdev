// The bundled SQL grammar ships without types (only its contribution has a
// .d.ts), and the editor extends the tokenizer, so declare the two exports.
declare module 'monaco-editor/esm/vs/basic-languages/sql/sql.js' {
  import type * as Monaco from 'monaco-editor'
  export const conf: Monaco.languages.LanguageConfiguration
  export const language: Monaco.languages.IMonarchLanguage
}
