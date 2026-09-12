import { reactive } from 'vue'
import { saveSettings, storageReady } from '../lib/storage'

interface SettingsState {
  groupObjects: boolean
}

const state = reactive<SettingsState>({
  groupObjects: true,
})

let readyPromise: Promise<void> | null = null
let locallyChanged = false

function ensureReady(): Promise<void> {
  if (!readyPromise) {
    readyPromise = storageReady
      .then(({ settings }) => {
        if (locallyChanged || !settings || typeof settings !== 'object') return
        const saved = settings as Partial<SettingsState>
        if (typeof saved.groupObjects === 'boolean') state.groupObjects = saved.groupObjects
      })
      .catch(() => undefined)
  }
  return readyPromise
}

function persist() {
  const value = { groupObjects: state.groupObjects }
  void ensureReady().then(() => saveSettings(value)).catch(() => undefined)
}

export function useSettings() {
  const ready = ensureReady()

  function setGroupObjects(enabled: boolean) {
    locallyChanged = true
    state.groupObjects = enabled
    persist()
  }

  return { state, setGroupObjects, ready }
}
