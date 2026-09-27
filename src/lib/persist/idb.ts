// A small key-value store over IndexedDB for session data too big for
// localStorage (uploaded bytes, traced documents, the sheet's source).
//
// Not shared with the labs' `labCache`: that cache is swept whenever the tracer
// changes, while these slots hold the user's own work and must survive a
// tracer release.
//
// Every operation degrades to a no-op instead of throwing.

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
    // Another tab holding an older version blocks the upgrade indefinitely;
    // resolve null instead of hanging the boot read.
    req.onblocked = () => resolve(null)
  })
  return dbPromise
}

/** Read several keys in one transaction. */
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
 * Write one slot. Resolves `false` when the value could not be stored (quota,
 * or a value structured clone rejects).
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

/** Drop every stored slot (start fresh). */
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
