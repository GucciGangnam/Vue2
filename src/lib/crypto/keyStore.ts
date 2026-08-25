/**
 * Device-local persistence for unlocked keys.
 *
 * IndexedDB can structured-clone a `CryptoKey`, and a non-extractable key stays
 * non-extractable across that round trip: the raw bytes are held by the browser,
 * not by our JavaScript. That means script running on this origin can *use* the
 * key but cannot read it out and post it somewhere -- which is exactly what we
 * want, and strictly better than keeping raw bytes in memory.
 *
 * Why persist at all: re-deriving an Argon2id key on every page refresh is ~1s
 * of jank and a password prompt each time. The device already holds a persisted
 * Supabase session, so caching the unlocked key does not widen the threat model
 * much -- both fall to an attacker with the unlocked device. Phase 4 needs this
 * store anyway, so the service worker can decrypt without the page being open.
 *
 * Cleared on sign-out.
 */

const DB_NAME = 'vue2-keys'
const DB_VERSION = 2
const STORE = 'keys'
/**
 * Everything the service worker needs to serve one video. It lives in
 * IndexedDB rather than being posted to the worker because a service worker is
 * killed and restarted freely -- anything held in its memory is gone by the
 * next range request, which for a two-hour film is a certainty, not a risk.
 */
const STREAM_STORE = 'streams'

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
      if (!db.objectStoreNames.contains(STREAM_STORE)) db.createObjectStore(STREAM_STORE)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Could not open key store'))
  })
}

async function withStore<T>(
  storeName: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await open()
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(storeName, mode)
      const request = run(tx.objectStore(storeName))
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('Key store operation failed'))
    })
  } finally {
    db.close()
  }
}

const identityKeyFor = (userId: string) => `identity:${userId}`

export async function putIdentityKey(userId: string, key: CryptoKey): Promise<void> {
  if (key.extractable) {
    // A key we could export is a key an attacker could export. Refuse loudly
    // rather than quietly persisting something exfiltratable.
    throw new Error('Refusing to persist an extractable identity key')
  }
  await withStore(STORE, 'readwrite', (store) => store.put(key, identityKeyFor(userId)))
}

export async function getIdentityKey(userId: string): Promise<CryptoKey | null> {
  try {
    const key = await withStore<CryptoKey | undefined>(STORE, 'readonly', (store) =>
      store.get(identityKeyFor(userId)),
    )
    return key ?? null
  } catch {
    // A broken key store must never block sign-in: fall back to asking for the
    // password.
    return null
  }
}

export async function clearIdentityKeys(): Promise<void> {
  try {
    await withStore(STORE, 'readwrite', (store) => store.clear())
  } catch {
    // Best effort. Sign-out must not fail because IndexedDB is unavailable.
  }
  // Content keys are key material too: signing out must not leave a previous
  // user's videos playable on a shared device.
  await clearStreamRecords()
}

/* -------------------------------------------------------------------------- */
/* Stream records -- what the service worker reads                             */
/* -------------------------------------------------------------------------- */

/** Everything needed to read one media object, minus the bytes themselves. */
export interface StreamRecord {
  mediaId: string
  /** Non-extractable content key. */
  key: CryptoKey
  noncePrefix: Uint8Array
  chunkSize: number
  chunkCount: number
  plaintextSize: number
  ciphertextSize: number
  mimeType: string
  /** Signed URL for the ciphertext object. */
  sourceUrl: string
  /** Epoch ms at which `sourceUrl` is expected to stop working. */
  expiresAt: number
}

export async function putStreamRecord(record: StreamRecord): Promise<void> {
  if (record.key.extractable) {
    throw new Error('Refusing to persist an extractable content key')
  }
  await withStore(STREAM_STORE, 'readwrite', (store) => store.put(record, record.mediaId))
}

export async function getStreamRecord(mediaId: string): Promise<StreamRecord | null> {
  try {
    const record = await withStore<StreamRecord | undefined>(STREAM_STORE, 'readonly', (store) =>
      store.get(mediaId),
    )
    return record ?? null
  } catch {
    return null
  }
}

export async function deleteStreamRecord(mediaId: string): Promise<void> {
  try {
    await withStore(STREAM_STORE, 'readwrite', (store) => store.delete(mediaId))
  } catch {
    // Best effort.
  }
}

export async function clearStreamRecords(): Promise<void> {
  try {
    await withStore(STREAM_STORE, 'readwrite', (store) => store.clear())
  } catch {
    // Best effort.
  }
}
