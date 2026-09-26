// What the vectorize studio remembers across a reload.
//
// Settings go to localStorage because the studio reads them synchronously while
// mounting; the document goes to IndexedDB (see lib/persist/session.ts).
//
// The document is stored with the `assetKey` of the image it was traced from, so
// a restore can tell whether it still belongs to the picture on screen. Without
// that check a new upload plus a reload would show the old trace over new art.

import type { EditableDoc } from '../../lib/path/types'
import type { VectorizeOptions } from '../../types'
import type { InkColorMode } from '../../lib/traceInput/ink'
import { debounce, readLocal, writeLocal } from '../../lib/persist/local'
import { claim, saveSlot, SLOTS, type StoredVectorize } from '../../lib/persist/session'

const LS_KEY = 'vectorize'

/** Every studio control that isn't the document itself. */
export interface StudioView {
  opts: VectorizeOptions
  colorMode: InkColorMode
  forceColorOn: boolean
  forceColor: string
  /**
   * Whether the user has set force-colour / gradients by hand. The auto-probes
   * are suppressed by these flags, not by the values, so a deliberate choice
   * survives a probe re-run.
   */
  forceColorTouched: boolean
  gradientsTouched: boolean
  /**
   * The image (store `assetKey`) these options were decided for. A restore only
   * suppresses the probes while this image is on screen (see probeLedger.ts).
   * Absent on older stored views.
   */
  probedAssetKey?: string | null
  retraceVector: 'clean' | 'retrace'
  viewMode: 'split' | 'traced' | 'original' | 'overlay' | 'difference'
  overlayOpacity: number
  markMode: 'separate' | 'flat' | 'remove'
}

/** The document half, once it has been matched against the current image. */
export interface StudioSeed {
  view: StudioView | null
  doc: EditableDoc | null
  /** The restored doc carries hand edits — a settings change must warn, not re-trace. */
  dirty: boolean
}

/**
 * Read the studio's stored state, once, for the image identified by `assetKey`.
 *
 * The document is *claimed*: taken out of the boot payload so that navigating
 * away from /vectorize and back re-mounts the studio against live state instead
 * of re-seeding the trace the user has since moved past.
 */
export function loadStudioSeed(assetKey: string): StudioSeed {
  const stored: StoredVectorize | null = claim('vectorize')
  const raw = readLocal<{ view: StudioView | null }>(LS_KEY, { view: null })
  return {
    view: raw.view ?? null,
    doc: stored && stored.assetKey === assetKey ? stored.doc : null,
    dirty: stored?.assetKey === assetKey ? stored.dirty : false,
  }
}

/** Debounced: every slider in the left rail fires this once per pointer move. */
export const saveStudioView = debounce((view: StudioView) => {
  writeLocal(LS_KEY, { view })
}, 300)

/**
 * Store the document. The debounce is longer than the other slots' because this
 * fires on every frame of a node drag and each write structured-clones the whole
 * document; `pagehide` flushes any pending write.
 */
export function saveStudioDoc(
  assetKey: string,
  doc: EditableDoc | null,
  dirty: boolean,
): void {
  if (!doc) {
    saveSlot(SLOTS.vectorize, null)
    return
  }
  saveSlot(SLOTS.vectorize, { assetKey, doc, dirty } satisfies Omit<StoredVectorize, 'v'>, 900)
}
