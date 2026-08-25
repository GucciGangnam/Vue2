/**
 * Argon2id key derivation.
 *
 * At m=64MiB this takes roughly 0.5-1.5s on a phone, which would visibly freeze
 * the UI. `deriveKey` therefore runs the work in a Web Worker when one is
 * available and falls back to running inline (tests, and any environment
 * without Worker support).
 */

import { argon2id } from 'hash-wasm'

export interface KdfParams {
  algo: 'argon2id'
  /** Memory cost in KiB. */
  m: number
  /** Iterations. */
  t: number
  /** Parallelism. */
  p: number
}

export const DEFAULT_KDF_PARAMS: KdfParams = { algo: 'argon2id', m: 65536, t: 3, p: 1 }

/**
 * Parse the `kdf_params` column. Cost is always read from the stored row so
 * parameters can be raised later without locking existing users out.
 */
export function parseKdfParams(raw: unknown): KdfParams {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_KDF_PARAMS
  const p = raw as Record<string, unknown>
  if (p.algo !== 'argon2id') {
    throw new Error(`Unsupported KDF "${String(p.algo)}"; this build only implements argon2id`)
  }
  const num = (v: unknown, fallback: number) => (typeof v === 'number' && v > 0 ? v : fallback)
  return {
    algo: 'argon2id',
    m: num(p.m, DEFAULT_KDF_PARAMS.m),
    t: num(p.t, DEFAULT_KDF_PARAMS.t),
    p: num(p.p, DEFAULT_KDF_PARAMS.p),
  }
}

/** Widen to the `Json` shape PostgREST expects for a `jsonb` column. */
export function kdfParamsToJson(params: KdfParams): Record<string, string | number> {
  return { algo: params.algo, m: params.m, t: params.t, p: params.p }
}

/** Run Argon2id on the current thread. Blocks -- prefer `deriveKey`. */
export async function deriveKeyInline(
  secret: string,
  salt: Uint8Array,
  params: KdfParams = DEFAULT_KDF_PARAMS,
): Promise<Uint8Array> {
  return argon2id({
    password: secret,
    salt,
    parallelism: params.p,
    iterations: params.t,
    memorySize: params.m,
    hashLength: 32,
    outputType: 'binary',
  })
}

let workerPromise: Promise<Worker> | null = null

function getWorker(): Promise<Worker> {
  workerPromise ??= Promise.resolve(
    new Worker(new URL('./kdf.worker.ts', import.meta.url), { type: 'module' }),
  )
  return workerPromise
}

/**
 * Derive a 32-byte key from a password or recovery phrase, off the main thread
 * where possible.
 */
export async function deriveKey(
  secret: string,
  salt: Uint8Array,
  params: KdfParams = DEFAULT_KDF_PARAMS,
): Promise<Uint8Array> {
  if (typeof Worker === 'undefined') {
    return deriveKeyInline(secret, salt, params)
  }

  const worker = await getWorker()
  const id = crypto.randomUUID()

  return new Promise<Uint8Array>((resolve, reject) => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { id: string; ok: boolean; key?: Uint8Array; error?: string }
      if (data.id !== id) return
      worker.removeEventListener('message', onMessage)
      if (data.ok && data.key) resolve(new Uint8Array(data.key))
      else reject(new Error(data.error ?? 'Key derivation failed'))
    }
    worker.addEventListener('message', onMessage)
    worker.postMessage({ id, secret, salt, params })
  })
}
