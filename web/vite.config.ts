import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  optimizeDeps: {
    // Monaco is imported through ESM subpaths. Listing them up front keeps the
    // dev optimizer from discovering one mid-session, which would rebuild the
    // bundle and force-reload the page under the caller (the browser suite
    // connects through the UI and loses its clicks across such a reload).
    include: [
      'monaco-editor/esm/vs/editor/editor.api',
      'monaco-editor/esm/vs/editor/editor.all.js',
      'monaco-editor/esm/vs/basic-languages/sql/sql.contribution.js',
      'monaco-editor/esm/vs/basic-languages/sql/sql.js',
    ],
  },
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
