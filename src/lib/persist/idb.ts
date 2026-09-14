// A tiny key→value store over IndexedDB, for the parts of a working session that
// are too big for localStorage: the uploaded bytes, the traced documents, the
// sheet's source image.
//
// Deliberately NOT the labs' `labCache` (components/labs/labCache.ts). That one
// is a content-addressed *cache* — every key carries the engine fingerprint and a
// sweep drops anything from an older one, because a stale trace there is wrong.
// This is the opposite contract: a handful of named slots holding the user's own
// work, which must survive an engine change (their hand-edited nodes are not
// invalidated by a tracer release). Same 40 lines of IDB boilerplate, opposite
// lifetime — sharing one module would mean sharing the sweep.
//
// Everything degrades to a no-op rather than throwing: private-mode Safari, a
// blocked origin and a full quota all show up here, and none of them is a reason
// for the app to stop working. A session that cannot be saved is just a session
// that does not come back.

const DB_NAME = 'logolab-session'
const STORE = 'state'
const DB_VERSION = 1

let dbPromise: Promise<IDBDatabase | null> | null = null

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null)
      return
    }
    let req: IDBOpenDBRequest
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION)
    } catch {
      resolve(null)
      return
    }
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => resolve(null)
    // A second tab holding an older version open blocks the upgrade forever;
    // resolve null instead of hanging the boot read behind it.
    req.onblocked = () => resolve(null)
  })
  return dbPromise
}

/** Read several keys in ONE transaction — the shape the boot restore wants. */
export async function idbGetMany(keys: readonly string[]): Promise<Map<string, unknown>> {
  const out = new Map<string, unknown>()
  const db = await openDb()
  if (!db) return out
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readonly')
      const store = tx.objectStore(STORE)
      for (const key of keys) {
        const req = store.get(key)
        req.onsuccess = () => {
          if (req.result !== undefined) out.set(key, req.result)
        }
      }
      tx.oncomplete = () => resolve(out)
      tx.onerror = () => resolve(out)
      tx.onabort = () => resolve(out)
    } catch {
      resolve(out)
    }
  })
}

/**
 * Write one slot. Resolves `false` when the value could not be stored — a quota
 * overrun or a value structured-clone refuses (a live ImageBitmap, a function on
 * a doc) — so a caller can drop the slot instead of retrying it forever.
 */
export async function idbSet(key: string, value: unknown): Promise<boolean> {
  const db = await openDb()
  if (!db) return false
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(value, key)
      tx.oncomplete = () => resolve(true)
      tx.onerror = () => resolve(false)
      tx.onabort = () => resolve(false)
    } catch {
      resolve(false)
    }
  })
}

export async function idbDelete(keys: readonly string[]): Promise<void> {
  const db = await openDb()
  if (!db) return
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite')
      for (const key of keys) tx.objectStore(STORE).delete(key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
      tx.onabort = () => resolve()
    } catch {
      resolve()
    }
  })
}

/** Drop every stored slot (the "start fresh" path). */
export async function idbClear(): Promise<void> {
  const db = await openDb()
  if (!db) return
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).clear()
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
      tx.onabort = () => resolve()
    } catch {
      resolve()
    }
  })
}
