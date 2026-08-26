import { describe, expect, it } from 'vitest'
import { isCacheable, routeFor } from './routing'

const ORIGIN = 'https://vue2.example'

function at(pathname: string, origin = ORIGIN) {
  return { origin, pathname }
}

const GET = { method: 'GET', mode: 'no-cors' }
const NAVIGATE = { method: 'GET', mode: 'navigate' }

describe('routeFor', () => {
  it('claims the streaming path', () => {
    expect(routeFor(GET, at('/__stream/86bef485-aef1-4324-9783-af81a354f087'), ORIGIN)).toBe(
      'stream',
    )
    expect(routeFor(GET, at('/__stream/__probe'), ORIGIN)).toBe('stream')
  })

  it('claims the streaming path before any caching rule, whatever the method', () => {
    // The ordering is the point: decrypted video must never reach a cache, so
    // a stream request must not be able to fall through into the asset or
    // navigation branches.
    expect(routeFor({ method: 'HEAD', mode: 'no-cors' }, at('/__stream/abc'), ORIGIN)).toBe(
      'stream',
    )
    expect(routeFor({ method: 'GET', mode: 'navigate' }, at('/__stream/abc'), ORIGIN)).toBe(
      'stream',
    )
  })

  it('serves navigations from the shell', () => {
    expect(routeFor(NAVIGATE, at('/'), ORIGIN)).toBe('navigate')
    expect(routeFor(NAVIGATE, at('/room/358cfa1f'), ORIGIN)).toBe('navigate')
    expect(routeFor(NAVIGATE, at('/watch/21b09679'), ORIGIN)).toBe('navigate')
  })

  it('caches hashed build assets', () => {
    expect(routeFor(GET, at('/assets/main-B8ml6u5x.js'), ORIGIN)).toBe('asset')
    expect(routeFor(GET, at('/assets/main-yMY9G5IT.css'), ORIGIN)).toBe('asset')
  })

  it('never claims the worker script itself', () => {
    // A worker served from a cache it controls could never replace itself.
    expect(routeFor(GET, at('/sw.js'), ORIGIN)).toBe('passthrough')
  })

  it('leaves other origins alone', () => {
    expect(routeFor(GET, at('/storage/v1/object/x', 'https://x.supabase.co'), ORIGIN)).toBe(
      'passthrough',
    )
    expect(routeFor(NAVIGATE, at('/', 'https://elsewhere.example'), ORIGIN)).toBe('passthrough')
  })

  it('never serves a non-GET from a cache', () => {
    expect(routeFor({ method: 'POST', mode: 'navigate' }, at('/library'), ORIGIN)).toBe(
      'passthrough',
    )
    expect(routeFor({ method: 'POST', mode: 'cors' }, at('/assets/main.js'), ORIGIN)).toBe(
      'passthrough',
    )
  })

  it('passes through anything else on our origin', () => {
    expect(routeFor(GET, at('/manifest.webmanifest'), ORIGIN)).toBe('passthrough')
    expect(routeFor(GET, at('/icons/icon-192.png'), ORIGIN)).toBe('passthrough')
  })
})

describe('isCacheable', () => {
  it('keeps a complete, successful, readable response', () => {
    expect(isCacheable({ ok: true, status: 200, type: 'basic' })).toBe(true)
  })

  it('refuses a partial response', () => {
    // Cached whole, a 206 would later be served as if it were the whole file.
    expect(isCacheable({ ok: true, status: 206, type: 'basic' })).toBe(false)
  })

  it('refuses errors and opaque responses', () => {
    expect(isCacheable({ ok: false, status: 404, type: 'basic' })).toBe(false)
    expect(isCacheable({ ok: false, status: 500, type: 'basic' })).toBe(false)
    expect(isCacheable({ ok: true, status: 200, type: 'opaque' })).toBe(false)
  })
})
