/// <reference lib="webworker" />

/**
 * Argon2id worker. Keeps a ~1s memory-hard derivation off the UI thread.
 * Protocol: { id, secret, salt, params } in, { id, ok, key | error } out.
 */

import { deriveKeyInline, type KdfParams } from './kdf'

interface Request {
  id: string
  secret: string
  salt: Uint8Array
  params: KdfParams
}

self.addEventListener('message', async (event: MessageEvent<Request>) => {
  const { id, secret, salt, params } = event.data
  try {
    const key = await deriveKeyInline(secret, salt, params)
    // Transfer rather than copy: one less lingering copy of key material.
    self.postMessage({ id, ok: true, key }, { transfer: [key.buffer] })
  } catch (error) {
    self.postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : 'Key derivation failed',
    })
  }
})
