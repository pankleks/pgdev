import type * as Monaco from 'monaco-editor'
import { useSchema } from '../composables/schema'
import { computeSignatureHelp, type SignatureHelpData } from '../lib/signature'

let registered = false

/**
 * Signature help for function and procedure calls: while the cursor sits
 * inside `name(…)`, show every overload with the active parameter highlighted.
 * The parsing lives in lib/signature.ts; this provider only supplies the
 * current schema.
 */
export function registerSqlSignature(monaco: typeof Monaco): void {
  if (registered) return
  registered = true

  const provider: Monaco.languages.SignatureHelpProvider = {
    signatureHelpTriggerCharacters: ['(', ','],
    signatureHelpRetriggerCharacters: [','],
    provideSignatureHelp(model, position) {
      const { state } = useSchema()
      const data = state.data
      if (!data) return null
      const help = computeSignatureHelp(data, model.getValue(), model.getOffsetAt(position))
      if (!help) return null
      return { value: help, dispose() {} }
    },
  }
  monaco.languages.registerSignatureHelpProvider('sql', provider)
}

/** Dev/test helper: the signature help the editor would show at a position. */
export function signatureHelp(
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
): SignatureHelpData | null {
  const { state } = useSchema()
  const data = state.data
  if (!data) return null
  return computeSignatureHelp(data, model.getValue(), model.getOffsetAt(position))
}
