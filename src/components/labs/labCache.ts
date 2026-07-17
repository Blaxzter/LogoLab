// A content-addressed store for deterministic lab results — so opening a lab does not re-churn
// through a whole corpus of traces + scores every time.
//
// Two tiers:
//   • an in-memory Map (this session): makes page-back, option-toggle-return and route
//     re-mounts instant — a lab re-run that lands on an already-computed case pays nothing.
//   • IndexedDB (across sessions): the "open the page and it's already there" win — nothing
//     re-churns on reload, only genuinely new cases/options compute.
//
// Every key is prefixed with ENGINE_HASH (the vectorizer+scoring fingerprint, see
// engineFingerprint.ts), so a code change makes every old key un-findable and the results
// recompute. A one-time sweep on open deletes the stragglers from prior fingerprints, so the
// store stays bounded to one engine version. Results are deterministic (verified byte-identical
// via hashDoc), so a content key needs NO time-based expiry — only completeness of the key.
//
// A value structured-clone can't store (or a lab that opts out) degrades to memory-only — never
// to a crash. The memory tier holds the rich value as-is; the IDB tier holds `serialize(value)`
// when a lab provides one (e.g. the Workbench strips a redundant 1 MB ImageData down to its
// dimensions), read straight back as the result type.

import { ENGINE_HASH } from './engineFingerprint'

const DB_NAME = 'logolab-labs'
const STORE = 'results'
const DB_VERSION = 1

/** `${ENGINE_HASH}:${labId}:${caseKey}:${optionsKey}` — assembled by useLabRun. */
export function labCacheKey(labId: string, caseKey: string, optionsKey: string): string {
  return `${ENGINE_HASH}:${labId}:${caseKey}:${optionsKey}`
}

// ── memory tier ──────────────────────────────────────────────────────────────────────────────
const mem = new Map<string, unknown>()

// ── IndexedDB tier ───────────────────────────────────────────────────────────────────────────
// One row: { key, engine, value }. `engine` exists only so the open-time sweep can drop rows
// left by earlier fingerprints (the key already encodes ENGINE_HASH, so reads can't collide).
interface Row {
  key: string
  engine: string
  value: unknown
}

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
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'key' })
        store.createIndex('engine', 'engine', { unique: false })
      }
    }
    req.onsuccess = () => {
      const db = req.result
      resolve(db)
      void sweepStaleEngines(db)
    }
    req.onerror = () => resolve(null) // private mode / blocked — fall back to memory-only
  })
  return dbPromise
}

// Delete every row whose fingerprint isn't the current one. Runs once, fire-and-forget, so the
// store never accumulates more than one engine version's worth of results.
let swept = false
function sweepStaleEngines(db: IDBDatabase): void {
  if (swept) return
  swept = true
  try {
    const tx = db.transaction(STORE, 'readwrite')
    const cursorReq = tx.objectStore(STORE).openCursor()
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result
      if (!cursor) return
      if ((cursor.value as Row).engine !== ENGINE_HASH) cursor.delete()
      cursor.continue()
    }
  } catch {
    /* a failed sweep just leaves stale rows unread; they never match a key, so it's harmless */
  }
}

function idbGet(key: string): Promise<unknown> {
  return openDb().then(
    (db) =>
      new Promise((resolve) => {
        if (!db) {
          resolve(undefined)
          return
        }
        try {
          const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key)
          req.onsuccess = () => resolve((req.result as Row | undefined)?.value)
          req.onerror = () => resolve(undefined)
        } catch {
          resolve(undefined)
        }
      }),
  )
}

function idbPut(key: string, value: unknown): void {
  void openDb().then((db) => {
    if (!db) return
    try {
      const row: Row = { key, engine: ENGINE_HASH, value }
      db.transaction(STORE, 'readwrite').objectStore(STORE).put(row)
    } catch {
      /* DataCloneError (a value IDB can't serialize) or a closed db — memory tier still serves it */
    }
  })
}

// ── public API ───────────────────────────────────────────────────────────────────────────────

/** Memory first (sync-fast), then IndexedDB; a persisted hit is promoted into memory. */
export async function labCacheGet<R>(key: string): Promise<R | undefined> {
  if (mem.has(key)) return mem.get(key) as R
  const raw = await idbGet(key)
  if (raw === undefined) return undefined
  mem.set(key, raw)
  return raw as R
}

/**
 * Store in both tiers. Memory keeps the rich value; IndexedDB gets `serialize(value)` if given
 * (identity otherwise). Fire-and-forget — the value is already computed, so the persist never
 * blocks the run loop, and an IDB write failure silently leaves the memory tier in charge.
 */
export function labCachePut<R>(key: string, value: R, serialize?: (v: R) => unknown): void {
  mem.set(key, value)
  idbPut(key, serialize ? serialize(value) : value)
}
