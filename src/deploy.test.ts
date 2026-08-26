import { describe, expect, it } from 'vitest'
// Read as text rather than through `node:fs`: the app tsconfig has no node
// types, deliberately, and this file lives alongside browser code.
import vercelJson from '../vercel.json?raw'

/**
 * Guards the deployment config against the one edit that breaks playback silently.
 *
 * A service worker cannot claim a scope broader than the path it is served from
 * (docs/DECISIONS.md D27), so the worker has to be a real file at `/sw.js`. A
 * catch-all SPA rewrite that swallows `/sw.js` does not error: registration
 * "succeeds" against an HTML document, the capability probe fails, and every
 * browser quietly downgrades to the staged path. Nothing on screen says why.
 *
 * Vercel checks the filesystem before it applies rewrites, so the real file
 * already wins; the negative lookahead in `rewrites[0].source` is deliberate
 * belt-and-braces on top of that. This test pins the lookahead so a later edit
 * cannot widen it back to `/(.*)` unnoticed.
 *
 * What this proves: the intent encoded in the pattern. What it does not prove:
 * that Vercel's own path-to-regexp translation agrees byte-for-byte. That is
 * confirmed against the deployed origin by fetching /sw.js and reading its
 * Content-Type, which is the check that actually settles it.
 */

interface VercelConfig {
  rewrites: { source: string; destination: string }[]
  headers: { source: string; headers: { key: string; value: string }[] }[]
}

const config = JSON.parse(vercelJson) as VercelConfig

const spaRewrite = config.rewrites[0]
const rewritePattern = new RegExp(`^${spaRewrite?.source}$`)

/** Paths that must be served as real files, never as the SPA shell. */
const servedAsFiles = [
  '/sw.js',
  '/assets/main-B8ml6u5x.js',
  '/assets/httpRange-CREz7oNw.js',
  '/assets/main-yMY9G5IT.css',
  '/favicon.svg',
  '/manifest.webmanifest',
  '/icons/icon-512.png',
]

/** Client routes that must survive a refresh by falling back to index.html. */
const servedAsAppShell = [
  '/',
  '/library',
  '/friends',
  '/room/358cfa1f-216c-490c-987b-0a479c304e4c',
  '/watch/21b09679-6074-41a9-b1c0-03f087877b88',
  '/sign-in',
]

describe('vercel.json SPA rewrite', () => {
  it('rewrites unmatched client routes to the app shell', () => {
    expect(spaRewrite?.destination).toBe('/index.html')
    for (const path of servedAsAppShell) {
      expect(rewritePattern.test(path), `${path} should fall back to index.html`).toBe(true)
    }
  })

  it('never rewrites the service worker or build assets', () => {
    for (const path of servedAsFiles) {
      expect(rewritePattern.test(path), `${path} must be served as a real file`).toBe(false)
    }
  })
})

describe('vercel.json headers', () => {
  const globalHeaders = config.headers.find((rule) => rule.source === '/(.*)')
  const csp = globalHeaders?.headers.find((h) => h.key === 'Content-Security-Policy')?.value ?? ''

  const directive = (name: string): string[] => {
    const found = csp
      .split(';')
      .map((part) => part.trim())
      .find((part) => part === name || part.startsWith(`${name} `))
    return found ? found.split(/\s+/).slice(1) : []
  }

  it('applies a CSP to every path, including the worker', () => {
    // The worker inherits the CSP delivered with its own script, so its fetches
    // to Supabase Storage are governed by connect-src below.
    expect(globalHeaders).toBeDefined()
    expect(csp).not.toBe('')
  })

  it('allows no third-party script on any route', () => {
    // ARCHITECTURE.md's honest-limit section rests on this specific claim.
    expect(directive('script-src')).toEqual(["'self'", "'wasm-unsafe-eval'"])
    expect(directive('default-src')).toEqual(["'self'"])
    expect(directive('object-src')).toEqual(["'none'"])
    expect(directive('script-src')).not.toContain("'unsafe-inline'")
  })

  it('permits WebAssembly without permitting eval, because Argon2id is the vault', () => {
    // `script-src 'self'` alone blocks WebAssembly.instantiate outright, which
    // kills hash-wasm, which kills the vault: sign-in falls through to the
    // unlock screen and stays there. The violation is raised inside the KDF
    // worker, so nothing appears in the page console and it reads as a code
    // bug. 'wasm-unsafe-eval' is the narrow directive for exactly this -- it
    // permits wasm compilation and still refuses eval() of a JS string.
    expect(directive('script-src')).toContain("'wasm-unsafe-eval'")
    expect(csp).not.toContain("'unsafe-eval';")
    expect(directive('script-src')).not.toContain("'unsafe-eval'")
  })

  it('reaches Supabase over REST and the realtime websocket, and nowhere else', () => {
    const connect = directive('connect-src')
    expect(connect).toContain("'self'")
    expect(connect).toContain('https://grzsrhsdifohwbmbpebi.supabase.co')
    expect(connect).toContain('wss://grzsrhsdifohwbmbpebi.supabase.co')
    expect(connect).toHaveLength(3)
  })

  it('permits the staged fallback to play a blob and posters to be data URLs', () => {
    expect(directive('media-src')).toEqual(["'self'", 'blob:'])
    expect(directive('img-src')).toEqual(["'self'", 'data:', 'blob:'])
    expect(directive('worker-src')).toEqual(["'self'"])
  })

  it('serves the worker uncached so an update is never stranded', () => {
    const swRule = config.headers.find((rule) => rule.source === '/sw.js')
    const cacheControl = swRule?.headers.find((h) => h.key === 'Cache-Control')?.value ?? ''
    expect(cacheControl).toContain('max-age=0')
  })
})
