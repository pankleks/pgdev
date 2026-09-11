import { createApp } from 'vue'
import App from './App.vue'
import './style.css'
import { registerSW } from 'virtual:pwa-register'

let updateServiceWorker: (() => Promise<void>) | undefined

updateServiceWorker = registerSW({
  immediate: true,
  onNeedRefresh() {
    if (window.confirm('A new pgDEV version is available. Reload now?')) {
      void updateServiceWorker?.()
    }
  },
})

createApp(App).mount('#app')
