import { reactive } from 'vue'

const state = reactive({ text: '', visible: false, timer: 0 })

export function useToast() {
  function show(text: string) {
    state.text = text
    state.visible = true
    window.clearTimeout(state.timer)
    state.timer = window.setTimeout(() => {
      state.visible = false
    }, 4000)
  }
  return { state, show }
}
