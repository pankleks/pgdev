import { reactive } from 'vue'
import { api } from '../api'
import type { SchemaData } from '../types'

const state = reactive<{ data: SchemaData | null; loading: boolean; error: string | null }>({
  data: null,
  loading: false,
  error: null,
})

let loadVersion = 0

export function useSchema() {
  async function load(id: string) {
    const version = ++loadVersion
    state.loading = true
    state.error = null
    try {
      const data = await api.schema(id)
      if (version === loadVersion) state.data = data
    } catch (e) {
      if (version === loadVersion) state.error = (e as Error).message
    } finally {
      if (version === loadVersion) state.loading = false
    }
  }

  function reset() {
    loadVersion++
    state.data = null
    state.loading = false
    state.error = null
  }

  return { state, load, reset }
}
