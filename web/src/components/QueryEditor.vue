<script setup lang="ts">
import { inject, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import monaco from '../monaco'
import { registerSqlCompletion, completionSuggestions } from '../monaco/completions'
import { registerSqlHover, hoverContents } from '../monaco/hover'
import { registerSqlSignature, signatureHelp as signatureHelpAt } from '../monaco/signature'
import { useTabs, type EditorTab } from '../composables/tabs'
import { useResults } from '../composables/results'
import { useSettings } from '../composables/settings'
import { useToast } from '../composables/toast'
import { formatSql } from '../lib/sqlformat'
import { modelUri } from '../lib/modeluri'
import { mapParams, parseParamValues } from '../lib/preparemap'
import { setFormatHandler, setInsertHandler, setParamsHandler, setSelectionGetter } from '../lib/formatbridge'

const props = defineProps<{ tab: EditorTab }>()
const el = ref<HTMLDivElement | null>(null)
const tabs = useTabs()
const results = useResults()
const settings = useSettings()
const toast = useToast()
const run = inject<(sql?: string) => void>('pgdev:run')

let editor: monaco.editor.IStandaloneCodeEditor | null = null
const models = new Map<string, monaco.editor.ITextModel>()
// Per-tab cursor/selection/scroll, captured when a tab stops being active and
// restored when it becomes active again. In-memory only: it survives tab
// switching, not page reloads.
const viewStates = new Map<string, monaco.editor.ICodeEditorViewState>()

onMounted(() => {
  if (!el.value) return
  editor = monaco.editor.create(el.value, {
    language: 'sql',
    theme: 'pgdev-dark',
    automaticLayout: true,
    minimap: { enabled: false },
    fontSize: settings.state.editorFontSize,
    tabSize: 4,
    insertSpaces: false,
    detectIndentation: false,
    scrollBeyondLastLine: false,
    wordWrap: 'on',
    renderWhitespace: 'selection',
    // The list is schema-driven (see monaco/completions.ts); Monaco's
    // document-word suggestions only duplicate what is already typed.
    wordBasedSuggestions: 'off',
  })
  // Applies both live changes from Settings and the persisted value arriving
  // from storage after this editor was created.
  watch(
    () => settings.state.editorFontSize,
    (size) => editor?.updateOptions({ fontSize: size }),
  )
  registerSqlCompletion(monaco)
  registerSqlHover(monaco)
  registerSqlSignature(monaco)
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
    run?.()
  })
  // F5 runs too. Monaco handles the keydown and cancels its default action, so
  // the browser's reload does not fire while the editor has focus.
  editor.addCommand(monaco.KeyCode.F5, () => {
    run?.()
  })
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyF, () => {
    formatActive()
  })
  setFormatHandler(() => formatActive())
  setParamsHandler((values) => mapParamsActive(values))
  // The AI bridge writes into the editor at the cursor (replacing a selection).
  setInsertHandler((text) => {
    if (!editor || props.tab.readOnly) return false
    const model = editor.getModel()
    if (!model) return false
    const selection = editor.getSelection() ?? model.getFullModelRange()
    editor.executeEdits('pgdev-ai', [{ range: selection, text, forceMoveMarkers: true }])
    return true
  })
  setSelectionGetter(() => {
    const model = editor?.getModel()
    const selection = editor?.getSelection()
    return model && selection && !selection.isEmpty() ? model.getValueInRange(selection) : undefined
  })
  applyTab(props.tab)
  // Dev-only handles so the browser suite can drive Monaco; stripped from the
  // production build by the constant-folded import.meta.env.DEV guard.
  if (import.meta.env.DEV) {
    ;(window as unknown as Record<string, unknown>).__pgdev = {
      editor,
      monaco,
      getReadOnly: () => !!editor?.getOption(monaco.editor.EditorOption.readOnly),
      getValue: () => editor?.getModel()?.getValue() ?? '',
      setValue: (text: string) => editor?.getModel()?.setValue(text),
      // With `needle`, the position is the end of the needle's last
      // occurrence (so call-site ranking and hover can be probed); without,
      // the end of the document, as before.
      suggestions: (needle?: string) => {
        const model = editor?.getModel()
        if (!model) return []
        let position: { lineNumber: number; column: number } | null = null
        if (needle) {
          const offset = model.getValue().lastIndexOf(needle)
          if (offset < 0) return []
          const at = model.getPositionAt(offset + needle.length)
          position = { lineNumber: at.lineNumber, column: at.column }
        } else {
          const end = model.getFullModelRange()
          position = { lineNumber: end.endLineNumber, column: end.endColumn }
        }
        return completionSuggestions(model, position as never).map((s) => ({
          label: typeof s.label === 'string' ? s.label : s.label.label,
          description: typeof s.label === 'string' ? undefined : s.label.description,
          kind: s.kind,
          detail: s.detail,
          // Snippet insert text (functions) is a plain string here; the
          // browser suite asserts it carries the call parentheses.
          insertText: typeof s.insertText === 'string' ? s.insertText : undefined,
          sortText: s.sortText,
        }))
      },
      hover: (needle: string) => {
        const model = editor?.getModel()
        if (!model || !needle) return null
        const offset = model.getValue().lastIndexOf(needle)
        if (offset < 0) return null
        return hoverContents(model, model.getPositionAt(offset + Math.floor(needle.length / 2)) as never)
      },
      // The cursor sits at the end of the needle, so a probe like `f(a,`
      // lands after the comma for active-parameter checks.
      signatureHelp: (needle: string) => {
        const model = editor?.getModel()
        if (!model || !needle) return null
        const offset = model.getValue().lastIndexOf(needle)
        if (offset < 0) return null
        return signatureHelpAt(model, model.getPositionAt(offset + needle.length) as never)
      },
      markers: () => monaco.editor.getModelMarkers({}),
    }
  }
})

function formatActive() {
  if (!editor || props.tab.readOnly) return
  const model = editor.getModel()
  if (!model) return
  const selection = editor.getSelection()
  const sel = selection && !selection.isEmpty() ? selection : null
  const selected = sel ? model.getValueInRange(sel) : ''
  if (sel && selected.trim()) {
    // Format just the selection (e.g. a function body) in place.
    let formatted: string
    try {
      formatted = formatSql(selected).replace(/\s+$/, '')
    } catch (e) {
      toast.show(`Format failed: ${(e as Error).message}`)
      return
    }
    if (!formatted || formatted === selected) return
    editor.executeEdits('pgdev-format', [{ range: sel, text: formatted }])
    return
  }
  const current = model.getValue()
  if (!current.trim()) return
  let formatted: string
  try {
    formatted = formatSql(current)
  } catch (e) {
    toast.show(`Format failed: ${(e as Error).message}`)
    return
  }
  const text = formatted.endsWith('\n') ? formatted : `${formatted}\n`
  if (text === current) return
  editor.executeEdits('pgdev-format', [{ range: model.getFullModelRange(), text }])
}

function mapParamsActive(valuesText?: string) {
  if (!editor || props.tab.readOnly) return
  const model = editor.getModel()
  if (!model) return
  const selection = editor.getSelection()
  const range = selection && !selection.isEmpty() ? selection : model.getFullModelRange()
  const sql = model.getValueInRange(range)
  if (!sql.trim()) return
  const override = valuesText ? parseParamValues(valuesText) : null
  if (valuesText?.trim() && !override) {
    toast.show('Could not parse parameter values — expected a JSON array like [1, "text", false, null]')
    return
  }
  const script = mapParams(sql, override ?? undefined)
  if (!script) {
    toast.show('No query parameters found')
    return
  }
  editor.executeEdits('pgdev-prepare', [{ range, text: script }])
}

function modelFor(tab: EditorTab): monaco.editor.ITextModel {
  let model = models.get(tab.key)
  if (!model) {
    model = monaco.editor.createModel(tab.content, 'sql', monaco.Uri.parse(modelUri(tab.key)))
    model.onDidChangeContent(() => {
      // A stale error squiggle must not linger once the user edits.
      monaco.editor.setModelMarkers(model!, 'pgdev-sql', [])
      tabs.updateContent(tab.key, model!.getValue())
    })
    models.set(tab.key, model)
  }
  return model
}

function applyTab(tab: EditorTab) {
  if (!editor) return
  // Keep the outgoing tab's cursor/scroll before swapping the model —
  // `setModel` resets view state, so tab switches would otherwise always
  // land at the top of the file.
  const outgoing = editor.getModel()
  if (outgoing) {
    const key = [...models.entries()].find(([, m]) => m === outgoing)?.[0]
    const state = editor.saveViewState()
    if (key && state) viewStates.set(key, state)
  }
  const model = modelFor(tab)
  // Push refreshed DDL (or any external update) into the existing model.
  if (model.getValue() !== tab.content) model.setValue(tab.content)
  editor.setModel(model)
  const saved = viewStates.get(tab.key)
  if (saved) editor.restoreViewState(saved)
  editor.updateOptions({ readOnly: tab.readOnly })
}

function syncExternalContent(tab: EditorTab) {
  const model = models.get(tab.key)
  if (!model || model.getValue() === tab.content) return
  model.setValue(tab.content)
  // An external overwrite of the active tab (DDL refresh, AI staged SQL)
  // must not yank the cursor to line 1; put the saved view state back.
  if (editor?.getModel() === model) {
    const saved = viewStates.get(tab.key)
    if (saved) editor.restoreViewState(saved)
  }
}

/**
 * SQL syntax-error squiggle (Phase 1): the server returns PostgreSQL's
 * 1-based error offset within the sent statement, which `results` keeps on
 * the tab's error message. Treat it as relative to the sent SQL — exact for
 * single-statement runs; multi-statement batches need the statement-index
 * mapping (Phase 2) to point precisely.
 */
function syncErrorMarker(tabKey: string, reveal: boolean) {
  const model = models.get(tabKey)
  if (!model) return
  const messages = results.state.byTab[tabKey]?.messages ?? []
  const failure = [...messages].reverse().find((m) => m.level === 'error' && m.position)
  if (!failure?.position) {
    monaco.editor.setModelMarkers(model, 'pgdev-sql', [])
    return
  }
  const offset = Number(failure.position) - 1
  if (!Number.isFinite(offset)) {
    monaco.editor.setModelMarkers(model, 'pgdev-sql', [])
    return
  }
  const clamped = Math.max(0, Math.min(model.getValueLength(), Math.floor(offset)))
  const pos = model.getPositionAt(clamped)
  // Cover the erroneous token when one starts here, else a single character.
  const word = model.getWordAtPosition(pos)
  const end =
    word && word.startColumn <= pos.column
      ? { lineNumber: pos.lineNumber, column: word.endColumn }
      : model.getPositionAt(Math.min(model.getValueLength(), clamped + 1))
  monaco.editor.setModelMarkers(model, 'pgdev-sql', [
    {
      severity: monaco.MarkerSeverity.Error,
      message: failure.text,
      startLineNumber: pos.lineNumber,
      startColumn: pos.column,
      endLineNumber: end.lineNumber,
      endColumn: end.column,
    },
  ])
  if (reveal && editor?.getModel() === model) editor.revealPositionInCenter(pos)
}

function showErrorMarker(tabKey: string) {
  syncErrorMarker(tabKey, true)
}

watch(
  () => props.tab,
  (tab) => {
    applyTab(tab)
    // No reveal here: a tab switch must restore the saved cursor/scroll, not
    // jump to a stale error. Reveal only fires on a fresh failure below.
    syncErrorMarker(tab.key, false)
  },
)

// Re-render the squiggle when the active tab's messages change (run starts,
// fails with a position, or succeeds and clears it).
watch(
  () => {
    const r = results.state.byTab[props.tab.key]
    const last = r?.messages.at(-1)
    return r ? `${r.operation}:${r.messages.length}:${last?.position ?? ''}:${last?.text ?? ''}` : 'none'
  },
  () => showErrorMarker(props.tab.key),
)

watch(
  () => props.tab.content,
  () => syncExternalContent(props.tab),
)

watch(
  () => props.tab.readOnly,
  (readOnly) => editor?.updateOptions({ readOnly }),
)

watch(
  () => tabs.state.tabs.map((t) => t.key),
  (keys) => {
    for (const [key, model] of models) {
      if (!keys.includes(key)) {
        model.dispose()
        models.delete(key)
        viewStates.delete(key)
      }
    }
  },
)

onBeforeUnmount(() => {
  setFormatHandler(null)
  setParamsHandler(null)
  setSelectionGetter(null)
  setInsertHandler(null)
  editor?.dispose()
  models.forEach((m) => m.dispose())
  models.clear()
  viewStates.clear()
})
</script>

<template>
  <div ref="el" class="editor-host" />
</template>
