/**
 * Which of the worker's jobs, if any, a request belongs to.
 *
 * Split out and kept pure because this is the file that decides whether the
 * app-shell cache can ever get near the streaming path -- and it must not. A
 * decrypted video is never written to any cache (see the header of
 * `stream.ts`), so `stream` has to win before the caching rules are even
 * considered, and a mistake here would be a privacy bug rather than a
 * performance one. Easier to be sure of as a function returning a string than
 * as a chain of `if`s inside a fetch listener.
 */

export const STREAM_PREFIX = '/__stream/'
const ASSET_PREFIX = '/assets/'

export type Route =
  /** Decrypt and serve. Never cached, never touched by anything below. */
  | 'stream'
  /** An app-shell navigation: network first, cached shell if offline. */
  | 'navigate'
  /** A hashed build asset: immutable, so cache first. */
  | 'asset'
  /** Not ours. Straight to the network. */
  | 'passthrough'

export function routeFor(
  request: { method: string; mode: string },
  url: { origin: string; pathname: string },
  workerOrigin: string,
): Route {
  if (url.origin !== workerOrigin) return 'passthrough'
  if (url.pathname.startsWith(STREAM_PREFIX)) return 'stream'

  // Only GETs are ever served from a cache. A navigation that is a form POST
  // must reach the network or the user silently loses what they submitted.
  if (request.method !== 'GET') return 'passthrough'

  if (request.mode === 'navigate') return 'navigate'

  // Hashed filenames, so the content behind one can never change: a cache hit
  // is always correct, and a new build asks for new names.
  if (url.pathname.startsWith(ASSET_PREFIX)) return 'asset'

  // Everything else -- the worker script itself, the manifest, icons -- goes
  // to the network. /sw.js in particular must never be served from a cache we
  // control, or a broken worker could never replace itself.
  return 'passthrough'
}

/** Is this response safe and useful to keep? */
export function isCacheable(response: { ok: boolean; status: number; type: string }): boolean {
  // 206 is the one to exclude deliberately: a partial response cached whole
  // would be served later as if it were the entire resource.
  return response.ok && response.status === 200 && response.type !== 'opaque'
}
