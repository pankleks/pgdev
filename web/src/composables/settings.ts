import { reactive } from 'vue'

const SETTINGS_KEY = 'pgdev.settings'

interface SettingsState {
  groupObjects: boolean
}

const state = reactive<SettingsState>({
  groupObjects: true,
})

let loaded = false

function load() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return
    const saved = JSON.parse(raw) as Partial<SettingsState>
    if (typeof saved.groupObjects === 'boolean') state.groupObjects = saved.groupObjects
  } catch {
    // Ignore malformed or unavailable browser storage.
  }
}

function persist() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(state))
  } catch {
    // Ignore unavailable browser storage.
  }
}

export function useSettings() {
  if (!loaded) {
    load()
    loaded = true
  }

  function setGroupObjects(enabled: boolean) {
    state.groupObjects = enabled
    persist()
  }

  return { state, setGroupObjects }
}
