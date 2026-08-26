import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, type Plugin } from 'vitest/config'

const swSource = './src/sw/stream.ts'

/**
 * Serve `vercel.json`'s response headers from `vite preview`.
 *
 * Without this, preview is a materially different app from the deployed one,
 * and the difference is the kind that does not announce itself: a bare
 * `script-src 'self'` blocks WebAssembly, which stops Argon2id, which means
 * the vault never unlocks -- and the violation is raised inside the key
 * derivation worker, so nothing appears in the page console. That was found by
 * hand once. Applying the real headers here is what makes the end-to-end tests
 * able to find it instead.
 *
 * Preview only. The dev server needs inline script and eval for HMR, so the
 * production policy would simply break it.
 */
function vercelHeadersInPreview(): Plugin {
  interface Rule {
    source: string
    headers: { key: string; value: string }[]
  }

  return {
    name: 'vue2:vercel-headers-preview',
    apply: 'serve',
    configurePreviewServer(server) {
      const config = JSON.parse(
        readFileSync(fileURLToPath(new URL('./vercel.json', import.meta.url)), 'utf8'),
      ) as { headers: Rule[] }

      const rules = config.headers.map((rule) => ({
        test: new RegExp(`^${rule.source}$`),
        headers: rule.headers,
      }))

      server.middlewares.use((request, response, next) => {
        const pathname = (request.url ?? '/').split('?')[0] ?? '/'
        for (const rule of rules) {
          if (!rule.test.test(pathname)) continue
          for (const { key, value } of rule.headers) response.setHeader(key, value)
        }
        next()
      })
    },
  }
}

/**
 * Serve the streaming worker at `/sw.js` during development.
 *
 * A service worker's scope cannot be broader than the path it is served from,
 * so a worker delivered as `/src/sw/stream.ts` could only ever intercept
 * `/src/sw/`, which is useless -- it has to reach `/__stream/`. Rather than
 * fight that with a `Service-Worker-Allowed` header, we serve a one-line module
 * from the root that imports the real source. Vite then transforms the source
 * and its imports as normal, so HMR-free but fully typed dev works.
 *
 * The build does the same job with a second Rollup entry (see below).
 */
function streamWorkerDevServer(): Plugin {
  return {
    name: 'vue2:stream-worker-dev',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if ((request.url ?? '').split('?')[0] !== '/sw.js') return next()
        response.setHeader('Content-Type', 'text/javascript')
        response.setHeader('Service-Worker-Allowed', '/')
        // A stale worker is genuinely confusing to debug; never cache it.
        response.setHeader('Cache-Control', 'no-store')
        response.end(`import '${swSource.replace('./', '/')}'\n`)
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), streamWorkerDevServer(), vercelHeadersInPreview()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        sw: fileURLToPath(new URL(swSource, import.meta.url)),
      },
      output: {
        // The worker must land at the root to claim the whole origin as scope.
        entryFileNames: (chunk) => (chunk.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js'),
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    globals: true,
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
})
