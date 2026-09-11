import { reactive } from 'vue'
import { api } from '../api'
import type { SchemaData } from '../types'

const state = reactive<{ data: SchemaData | null; loading: boolean; error: string | null }>({
  data: null,
  loading: false,
  error: null,
})

export function useSchema() {
  async function load(id: string) {
    state.loading = true
    state.error = null
    try {
      state.data = await api.schema(id)
    } catch (e) {
      state.error = (e as Error).message
    } finally {
      state.loading = false
    }
  }

  function reset() {
    state.data = null
    state.error = null
  }

  return { state, load, reset }
}
