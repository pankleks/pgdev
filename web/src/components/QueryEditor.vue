<script setup lang="ts">
import { inject, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import monaco from '../monaco'
import { registerSqlCompletion, completionSuggestions } from '../monaco/completions'
import { registerSqlHover, hoverContents } from '../monaco/hover'
import { useTabs, type EditorTab } from '../composables/tabs'
import { useSettings } from '../composables/settings'
import { useToast } from '../composables/toast'
import { formatSql } from '../lib/sqlformat'
import { setFormatHandler, setSelectionGetter } from '../lib/formatbridge'

const props = defineProps<{ tab: EditorTab }>()
const el = ref<HTMLDivElement | null>(null)
const tabs = useTabs()
const settings = useSettings()
const toast = useToast()
const run = inject<(sql?: string) => void>('pgdev:run')

let editor: monaco.editor.IStandaloneCodeEditor | null = null
const models = new Map<string, monaco.editor.ITextModel>()

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
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
    run?.()
  })
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyF, () => {
    formatActive()
  })
  setFormatHandler(() => formatActive())
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

function modelFor(tab: EditorTab): monaco.editor.ITextModel {
  let model = models.get(tab.key)
  if (!model) {
    const uri = monaco.Uri.parse(
      `inmemory://pgdev/${tab.key.replace(/[^a-z0-9-]/gi, '_')}.sql`,
    )
    model = monaco.editor.createModel(tab.content, 'sql', uri)
    model.onDidChangeContent(() => tabs.updateContent(tab.key, model!.getValue()))
    models.set(tab.key, model)
  }
  return model
}

function applyTab(tab: EditorTab) {
  if (!editor) return
  const model = modelFor(tab)
  // Push refreshed DDL (or any external update) into the existing model.
  if (model.getValue() !== tab.content) model.setValue(tab.content)
  editor.setModel(model)
  editor.updateOptions({ readOnly: tab.readOnly })
}

function syncExternalContent(tab: EditorTab) {
  const model = models.get(tab.key)
  if (model && model.getValue() !== tab.content) model.setValue(tab.content)
}

watch(
  () => props.tab,
  (tab) => applyTab(tab),
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
      }
    }
  },
)

onBeforeUnmount(() => {
  setFormatHandler(null)
  setSelectionGetter(null)
  editor?.dispose()
  models.forEach((m) => m.dispose())
  models.clear()
})
</script>

<template>
  <div ref="el" class="editor-host" />
</template>
