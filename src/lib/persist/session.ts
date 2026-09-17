// The working session: what the app remembers across a reload.
//
// The contract is "a refresh costs you nothing". A trace on a large flat source
// takes seconds and a node-editing session takes minutes; before this, both went
// away on F5, along with the upload, the appearance, the sheet and the export
// selection. The only thing that survived was the theme.
//
// WHERE a slice lives follows from WHEN it is needed:
//
//   • localStorage — anything that must be right in the FIRST painted frame.
//     Appearance, trace options, export selection: the stores seed themselves
//     from it synchronously in `create()`, so there is no frame of defaults
//     snapping to the user's settings. Handled in ./local.
//   • IndexedDB — bytes and documents. The upload, the traced EditableDocs, the
//     sheet's source image, the cleanup canvas. Read ONCE at boot (`loadSession`
//     in main.tsx, before the first render) into a module-level object that
//     panels claim synchronously on mount, so a lazily-mounted studio never has
//     to race an async read against its own auto-trace.
//
// Nothing here throws. Every store and read is best-effort: private mode, a full
// quota and a blocked origin all just mean the session doesn't come back.

import type { EditableDoc } from '../path/types'
import type { VectorizeOptions } from '../../types'
import { idbClear, idbDelete, idbGetMany, idbSet } from './idb'
import { clearLocal, debounce } from './local'
import { markArmed, markRestored, markSettled, resetSaveStatus } from './status'

// Re-exported so the UI has ONE persistence entry point rather than reaching
// past this module into its internals.
export { getSaveStatus, subscribeSaveStatus, type SaveStatus } from './status'

/**
 * Bumped when a stored shape changes incompatibly. Everything with a different
 * stamp is ignored (and overwritten on the next save), so an old record can
 * never be read as a new one.
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
  /** When this slot was written (epoch ms) — what the Saved chip reports after a
   *  reload, so the indicator describes the DATA's age rather than the tab's. */
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
  /** Identifies the WORKING image; slices derived from it store the same key. */
  assetKey: string
  fileName: string | null
  /** The pristine upload. */
  original: Blob
  originalMeta: LogoMeta
  /**
   * The working image when it is no longer the upload — a cleanup result, an
   * applied trace. Null means the working image IS the original.
   */
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

/** The SVG editor's open document. Tab-local by design, and not the app's logo. */
export interface StoredEditor extends Stamped {
  doc: EditableDoc
  name: string
}

/**
 * Un-applied cleanup pixels, keyed to the image they were cut from.
 *
 * The guided keep/remove PINS are not here, on purpose: they are a transient
 * affordance over a change that is already baked into these pixels (the studio
 * itself drops them on every buffer reshape), so restoring them would put
 * markers back over work they no longer describe.
 */
export interface StoredCleanup extends Stamped {
  assetKey: string
  /** The working canvas as PNG bytes. */
  working: Blob
}

/**
 * The icon sheet: its source bytes and every tile, traces included. The decoded
 * ImageData is NOT stored — it is megabytes of pixels that re-derive from the
 * source blob in one decode, and storing it would double the slot for nothing.
 *
 * The tile and settings shapes are the sheet store's own; they are typed loosely
 * here so the boot path doesn't drag that whole vocabulary in, and the store
 * validates what it takes back.
 */
export interface StoredSheet extends Stamped {
  source: Blob
  fileName: string | null
  width: number
  height: number
  svgText: string | null
  tiles: unknown[]
  selectedId: string | null
  /** Detection OUTPUT, kept so a restore doesn't have to re-split the sheet. */
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

/** True when the boot read actually found work to bring back (drives the banner). */
export function sessionWasRestored(): boolean {
  return didRestore
}

function stamped<T extends Stamped>(value: unknown): T | null {
  if (!value || typeof value !== 'object') return null
  return (value as Stamped).v === SESSION_VERSION ? (value as T) : null
}

/**
 * Read every slot in one transaction. Called once from main.tsx BEFORE the first
 * render — see the module header for why the panels want it synchronous after.
 */
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
  // The newest slot dates the session as a whole: the chip should say when the
  // work was last written, and one slot being older than another is an artifact
  // of which studio was touched last, not of when "the session" was saved.
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
 * later in the session starts from live state instead of re-seeding the document
 * the user has since moved past.
 */
export function claim<K extends keyof RestoredSession>(key: K): RestoredSession[K] {
  const value = restored[key]
  restored = { ...restored, [key]: null }
  return value
}

/* ------------------------------------------------------------------ writing */

/**
 * One debounced writer per slot. Per-slot rather than one session document
 * because the slots change at wildly different rates and sizes: a node drag
 * rewrites the vectorize doc continuously while the upload's bytes have not
 * moved since the file was dropped, and re-storing megabytes of source image on
 * every node nudge is exactly the stall this is meant to prevent.
 */
const writers = new Map<Slot, ReturnType<typeof debounce<[unknown]>>>()

function writerFor(slot: Slot, ms: number) {
  let writer = writers.get(slot)
  if (!writer) {
    writer = debounce<[unknown]>((value) => {
      // Read the armed count BEFORE the write, not after: anything armed while
      // this one is in flight is a newer value, and the status has to keep
      // saying "saving" for it. See lib/persist/status.ts.
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
  // Armed here as well as at write time, so the status turns to "saving" the
  // moment an edit lands rather than a debounce later — which is exactly the
  // window a user watching the chip would most want to see covered.
  markArmed(slot)
  writerFor(slot, ms)({ ...value, v: SESSION_VERSION, t: Date.now() })
}

/** Push every pending write out now — the page is hiding and may not come back. */
export function flushSession(): void {
  for (const writer of writers.values()) writer.flush()
}

/**
 * Forget the stored session and reload onto a clean one.
 *
 * A reload rather than a state reset because the studios seed themselves from
 * storage while they mount, so "fresh" has to mean a fresh boot. Shared by the
 * Saved chip and by the crash screen's "Start over" — which is the last resort
 * for a stored document that crashes the panel that restores it.
 */
export async function startFreshSession(): Promise<void> {
  await clearSession()
  location.reload()
}

/** Forget everything — the "start fresh" path. Theme is not ours and survives. */
export async function clearSession(): Promise<void> {
  writers.clear()
  restored = EMPTY
  didRestore = false
  resetSaveStatus()
  clearLocal()
  await idbClear()
}

/* ------------------------------------------------------------------ helpers */

/**
 * The bytes behind a `src`, whatever kind of URL it is. The store holds object
 * URLs for uploads and traced SVGs, data URLs for cleanup results, and plain
 * paths for the bundled examples; `fetch` reads all three, and an object URL
 * never leaves the tab so there is no request here in any real sense.
 */
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
 * A fresh identity for the working image. Slices derived from the pixels (the
 * trace, the cleanup buffer) record the key they were made from and are dropped
 * when it no longer matches — which is what stops a restored document from being
 * shown over a different image than it was traced from.
 */
export function newAssetKey(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
  }
}

/**
 * Ask the browser to keep this origin's storage out of the eviction pool. Best
 * effort and silent: Chrome grants it once the app is installed or sufficiently
 * engaged, Firefox prompts, Safari ignores it. Without it a "nothing is lost"
 * promise is only true until the device runs low on disk.
 */
export function requestPersistentStorage(): void {
  try {
    void navigator.storage?.persist?.()
  } catch {
    /* not supported — the session is still stored, just evictable */
  }
}
