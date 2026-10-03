import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

// Build output lives outside the repository: r2/build/r2-vis/dist.
const outDir = fileURLToPath(new URL('../../build/r2-vis/dist', import.meta.url))

export default defineConfig({
  plugins: [react()],
  base: './',
  build: { outDir, emptyOutDir: true, target: 'es2022' },
  worker: { format: 'es' },
  server: { port: 5173, host: '127.0.0.1' },
})
