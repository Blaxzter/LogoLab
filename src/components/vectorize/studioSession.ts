// What the vectorize studio remembers across a reload.
//
// Split the way the rest of the session is (see lib/persist/session.ts): the
// settings go to localStorage because the studio reads them synchronously while
// mounting, and the DOCUMENT goes to IndexedDB because it is the expensive part
// — a trace is seconds of work and a node-editing pass is minutes of it.
//
// The document is stored with the `assetKey` of the image it was traced from, so
// a restore can tell whether it still belongs to the picture on screen. Without
// that check, uploading a new logo and reloading would show last week's trace
// over this week's art.

import type { EditableDoc } from '../../lib/path/types'
import type { VectorizeOptions } from '../../types'
import type { InkColorMode } from '../../lib/ink'
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
   * Whether the user has touched force-colour / gradients by hand. Persisted
   * alongside the values because the studio's two auto-probes (the ink offer and
   * the rampiness probe) re-run on the restored image and would otherwise
   * overwrite a deliberate choice with their own — the probes are suppressed by
   * these flags, not by the values.
   */
  forceColorTouched: boolean
  gradientsTouched: boolean
  retraceVector: 'clean' | 'retrace'
  viewMode: 'split' | 'traced' | 'original' | 'overlay'
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
 * Store the document. The debounce is longer than the other slots': this fires
 * on every frame of a node drag, and each write structured-clones the whole
 * document. A second of lag costs nothing (a `pagehide` flushes it) and keeps
 * the drag smooth on a doc with thousands of nodes.
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
