import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Build output: web/dist, or the directory in R2VIS_DIST.
const outDir = process.env.R2VIS_DIST ?? 'dist'

export default defineConfig({
  plugins: [react()],
  base: './',
  build: { outDir, emptyOutDir: true, target: 'es2022' },
  worker: { format: 'es' },
  server: { port: 5173, host: '127.0.0.1' },
})
