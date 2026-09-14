import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      // PGDEV_API_PORT lets the browser suite run the API on a spare port;
      // the dev default stays 3010.
      '/api': `http://127.0.0.1:${process.env.PGDEV_API_PORT ?? 3010}`,
    },
  },
  build: {
    chunkSizeWarningLimit: 5000,
  },
})
