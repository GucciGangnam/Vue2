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
const DB_VERSION = 1
const STORE = 'keys'

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Could not open key store'))
  })
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await open()
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode)
      const request = run(tx.objectStore(STORE))
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
  await withStore('readwrite', (store) => store.put(key, identityKeyFor(userId)))
}

export async function getIdentityKey(userId: string): Promise<CryptoKey | null> {
  try {
    const key = await withStore<CryptoKey | undefined>('readonly', (store) =>
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
    await withStore('readwrite', (store) => store.clear())
  } catch {
    // Best effort. Sign-out must not fail because IndexedDB is unavailable.
  }
}
