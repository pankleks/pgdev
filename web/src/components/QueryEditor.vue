<script setup lang="ts">
import { inject, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import monaco from '../monaco'
import { registerSqlCompletion } from '../monaco/completions'
import { useTabs, type EditorTab } from '../composables/tabs'
import { formatSql } from '../lib/sqlformat'
import { setFormatHandler } from '../lib/formatbridge'

const props = defineProps<{ tab: EditorTab }>()
const el = ref<HTMLDivElement | null>(null)
const tabs = useTabs()
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
    const model = editor?.getModel()
    const selection = editor?.getSelection()
    const selected =
      model && selection && !selection.isEmpty() ? model.getValueInRange(selection) : undefined
    run?.(selected)
  })
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyF, () => {
    formatActive()
  })
  setFormatHandler(() => formatActive())
  applyTab(props.tab)
})

function formatActive() {
  if (!editor || props.tab.readOnly) return
  const model = editor.getModel()
  if (!model) return
  editor.executeEdits('pgdev-format', [
    { range: model.getFullModelRange(), text: formatSql(model.getValue()) + '\n' },
  ])
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
  editor.setModel(modelFor(tab))
  editor.updateOptions({ readOnly: tab.readOnly })
}

watch(
  () => props.tab,
  (tab) => applyTab(tab),
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
  editor?.dispose()
  models.forEach((m) => m.dispose())
  models.clear()
})
</script>

<template>
  <div ref="el" class="editor-host" />
</template>
