import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vitest/config'

/** Emits /sw.js with the list of built files to precache; the cache name changes with the build. */
function serviceWorker(): Plugin {
  return {
    name: 'service-worker',
    apply: 'build',
    generateBundle(_, bundle) {
      // Fonts are cached on first use by the SW instead; no need to download every subset up front.
      const files = Object.keys(bundle).filter((name) => !name.endsWith('.woff2')).map((name) => `/${name}`)
      const precache = ['/index.html', '/favicon.svg', ...files]
      const hash = createHash('sha256').update(files.sort().join('\n')).digest('hex').slice(0, 12)
      const template = readFileSync(fileURLToPath(new URL('./sw/sw.js', import.meta.url)), 'utf8')
      const source = template.replace('__CACHE__', `judgeflow-${hash}`).replace('__PRECACHE__', JSON.stringify(JSON.stringify(precache)).slice(1, -1))
      this.emitFile({ type: 'asset', fileName: 'sw.js', source })
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), serviceWorker()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: { proxy: { '/api': 'http://localhost:8080' } },
  build: { outDir: 'dist', emptyOutDir: true },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
})
