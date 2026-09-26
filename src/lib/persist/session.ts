// The working session: what the app remembers across a reload.
//
// Where a slice lives depends on when it is needed:
//  - localStorage (./local): anything that must be right in the first painted
//    frame (appearance, trace options, export selection). Stores seed from it
//    synchronously, so defaults never flash before the user's settings.
//  - IndexedDB: bytes and documents (the upload, traced docs, the sheet, the
//    cleanup canvas). Read once in main.tsx before the first render into a
//    module-level payload that panels `claim()` synchronously on mount, so a
//    lazily mounted studio never races an async read against its auto-trace.
//
// Nothing here throws: private mode, a full quota or a blocked origin just
// mean the session doesn't come back.

import type { EditableDoc } from '../path/types'
import type { VectorizeOptions } from '../../types'
import { idbClear, idbDelete, idbGetMany, idbSet } from './idb'
import { clearLocal, debounce } from './local'
import { markArmed, markRestored, markSettled, resetSaveStatus } from './status'

// Re-exported so the UI has a single persistence entry point.
export { getSaveStatus, subscribeSaveStatus, type SaveStatus } from './status'

/**
 * Bump when a stored shape changes incompatibly. Records with a different
 * stamp are ignored and overwritten on the next save.
 */
const SESSION_VERSION = 1

/** IDB slot names. One slot per thing that can be independently invalidated. */
export const SLOTS = {
  logo: 'logo',
  mockShots: 'mock-shots',
  vectorize: 'vectorize',
  editor: 'editor',
  sheet: 'sheet',
  cleanup: 'cleanup',
} as const

export type Slot = (typeof SLOTS)[keyof typeof SLOTS]

interface Stamped {
  v: number
  /** When this slot was written (epoch ms); the Saved chip shows it after a reload. */
  t?: number
}

export interface LogoMeta {
  mime: string | null
  isSvg: boolean
  svgText: string | null
  naturalWidth: number
  naturalHeight: number
}

/** The upload, as bytes plus the metadata the store keeps beside it. */
export interface StoredLogo extends Stamped {
  /** Identifies the working image; slices derived from it store the same key. */
  assetKey: string
  fileName: string | null
  /** The pristine upload. */
  original: Blob
  originalMeta: LogoMeta
  /** The working image when it differs from the upload (cleanup result, applied trace); null otherwise. */
  working: Blob | null
  workingMeta: LogoMeta | null
}

/** Custom device screenshots dropped onto the mockups. */
export interface StoredMockShots extends Stamped {
  ios: Blob | null
  android: Blob | null
}

/** The vectorize studio's document — the expensive part of that tab. */
export interface StoredVectorize extends Stamped {
  assetKey: string
  doc: EditableDoc
  /** The doc carries hand edits, so a settings change must not silently re-trace. */
  dirty: boolean
}

/** The SVG editor's open document. */
export interface StoredEditor extends Stamped {
  doc: EditableDoc
  name: string
}

/**
 * Un-applied cleanup pixels, keyed to the image they were cut from. The
 * keep/remove pins are deliberately not stored: their effect is already baked
 * into these pixels.
 */
export interface StoredCleanup extends Stamped {
  assetKey: string
  /** The working canvas as PNG bytes. */
  working: Blob
}

/**
 * The icon sheet: source bytes and every tile, traces included. The decoded
 * pixels are not stored; they come back from one decode of the source.
 * Tile and settings shapes belong to the sheet store and are typed loosely here.
 */
export interface StoredSheet extends Stamped {
  source: Blob
  fileName: string | null
  width: number
  height: number
  svgText: string | null
  tiles: unknown[]
  selectedId: string | null
  /** Detection output, kept so a restore doesn't re-split the sheet. */
  background: unknown
  grid: unknown
  warnings: string[]
  detect: unknown
  traceOptions: VectorizeOptions
  colorMode: unknown
  gradientMode: unknown
  hiRes: boolean
  naming: unknown
}

/** Everything the boot read found, already version-checked. */
export interface RestoredSession {
  logo: StoredLogo | null
  mockShots: StoredMockShots | null
  vectorize: StoredVectorize | null
  editor: StoredEditor | null
  sheet: StoredSheet | null
  cleanup: StoredCleanup | null
}

const EMPTY: RestoredSession = {
  logo: null,
  mockShots: null,
  vectorize: null,
  editor: null,
  sheet: null,
  cleanup: null,
}

let restored: RestoredSession = EMPTY
let didRestore = false

/** True when the boot read found work to bring back. */
export function sessionWasRestored(): boolean {
  return didRestore
}

function stamped<T extends Stamped>(value: unknown): T | null {
  if (!value || typeof value !== 'object') return null
  return (value as Stamped).v === SESSION_VERSION ? (value as T) : null
}

/** Read every slot in one transaction. Called once from main.tsx before the first render. */
export async function loadSession(): Promise<RestoredSession> {
  const rows = await idbGetMany(Object.values(SLOTS))
  restored = {
    logo: stamped<StoredLogo>(rows.get(SLOTS.logo)),
    mockShots: stamped<StoredMockShots>(rows.get(SLOTS.mockShots)),
    vectorize: stamped<StoredVectorize>(rows.get(SLOTS.vectorize)),
    editor: stamped<StoredEditor>(rows.get(SLOTS.editor)),
    sheet: stamped<StoredSheet>(rows.get(SLOTS.sheet)),
    cleanup: stamped<StoredCleanup>(rows.get(SLOTS.cleanup)),
  }
  didRestore = Boolean(restored.logo || restored.editor || restored.sheet)
  // The newest slot dates the session as a whole.
  const newest = Math.max(
    0,
    ...Object.values(restored).map((slot) => (slot as Stamped | null)?.t ?? 0),
  )
  if (newest > 0) markRestored(newest)
  return restored
}

/** What the boot read found. Panels claim their own slice from here on mount. */
export function restoredSession(): RestoredSession {
  return restored
}

/**
 * Take a slice and clear it from the boot payload, so a studio that remounts
 * later starts from live state instead of the stale restored document.
 */
export function claim<K extends keyof RestoredSession>(key: K): RestoredSession[K] {
  const value = restored[key]
  restored = { ...restored, [key]: null }
  return value
}

/* ------------------------------------------------------------------ writing */

/**
 * One debounced writer per slot, since slots change at very different rates
 * and sizes (a node drag must not re-store the source image).
 */
const writers = new Map<Slot, ReturnType<typeof debounce<[unknown]>>>()

function writerFor(slot: Slot, ms: number) {
  let writer = writers.get(slot)
  if (!writer) {
    writer = debounce<[unknown]>((value) => {
      // Take the armed count before the write: anything armed while it is in
      // flight is newer, and the status must keep saying "saving" for it.
      const upTo = markArmed(slot)
      void idbSet(slot, value).then((ok) => markSettled(slot, upTo, ok))
    }, ms)
    writers.set(slot, writer)
  }
  return writer
}

/** Queue a slot write. `value === null` deletes the slot instead. */
export function saveSlot(slot: Slot, value: object | null, ms = 500): void {
  if (value === null) {
    writers.delete(slot)
    void idbDelete([slot])
    return
  }
  // Armed here as well as at write time, so the status turns to "saving" as
  // soon as an edit lands rather than after the debounce.
  markArmed(slot)
  writerFor(slot, ms)({ ...value, v: SESSION_VERSION, t: Date.now() })
}

/** Write every pending slot now; the page is hiding and may not come back. */
export function flushSession(): void {
  for (const writer of writers.values()) writer.flush()
}

/**
 * Forget the stored session and reload. A reload, not a state reset, because
 * the studios seed themselves from storage on mount. Also the crash screen's
 * "Start over", for a stored document that crashes the panel restoring it.
 */
export async function startFreshSession(): Promise<void> {
  await clearSession()
  location.reload()
}

/** Forget the stored session. The theme is stored separately and survives. */
export async function clearSession(): Promise<void> {
  writers.clear()
  restored = EMPTY
  didRestore = false
  resetSaveStatus()
  clearLocal()
  await idbClear()
}

/* ------------------------------------------------------------------ helpers */

/** The bytes behind a `src`: object URL, data URL or plain path all work with `fetch`. */
export async function srcToBlob(src: string): Promise<Blob | null> {
  try {
    const response = await fetch(src)
    if (!response.ok) return null
    return await response.blob()
  } catch {
    return null
  }
}

/**
 * A fresh identity for the working image. Derived slices record the key they
 * were made from and are dropped when it no longer matches, so a restored
 * trace is never shown over a different image.
 */
export function newAssetKey(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
  }
}

/**
 * Ask the browser to exempt this origin's storage from eviction. Best effort;
 * browsers differ in whether they grant, prompt or ignore it.
 */
export function requestPersistentStorage(): void {
  try {
    void navigator.storage?.persist?.()
  } catch {
    /* not supported: the session is still stored, just evictable */
  }
}
