<script setup lang="ts">
import { inject, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import monaco from '../monaco'
import { registerSqlCompletion } from '../monaco/completions'
import { useTabs, type EditorTab } from '../composables/tabs'
import { useToast } from '../composables/toast'
import { formatSql } from '../lib/sqlformat'
import { setFormatHandler, setSelectionGetter } from '../lib/formatbridge'

const props = defineProps<{ tab: EditorTab }>()
const el = ref<HTMLDivElement | null>(null)
const tabs = useTabs()
const toast = useToast()
const run = inject<(sql?: string) => void>('pgdev:run')

let editor: monaco.editor.IStandaloneCodeEditor | null = null
const models = new Map<string, monaco.editor.ITextModel>()

onMounted(() => {
  if (!el.value) return
  editor = monaco.editor.create(el.value, {
    language: 'sql',
    theme: 'vs-dark',
    automaticLayout: true,
    minimap: { enabled: false },
    fontSize: 13,
    tabSize: 2,
    scrollBeyondLastLine: false,
    wordWrap: 'on',
    renderWhitespace: 'selection',
  })
  registerSqlCompletion(monaco)
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
})

function formatActive() {
  if (!editor || props.tab.readOnly) return
  const model = editor.getModel()
  if (!model) return
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
