// What the cleanup studio remembers across a reload: tool settings in
// localStorage (read synchronously while the studio mounts), and the working
// pixels in IndexedDB. An un-applied cutout exists only in the studio's working
// buffer (the store still holds the original upload), so it has to be saved here.

import { getImageData } from '../../lib/image'
import { debounce, readLocal, writeLocal } from '../../lib/persist/local'
import { claim, saveSlot, SLOTS, type StoredCleanup } from '../../lib/persist/session'

const LS_KEY = 'cleanup'

/** Every knob on the left rail. Not the pins: see StoredCleanup. */
export interface CleanupSettings {
  viewMode: 'split' | 'result' | 'original' | 'overlay'
  tool: 'magic' | 'color' | 'erase' | 'restore' | 'keep' | 'remove'
  tolerance: number
  softness: number
  brushSize: number
  defringeStrength: number
  ghostOpacity: number
  matteOn: boolean
  matteColor: string
  edgeShift: number
  feather: number
  defringeAmt: number
  trimPad: number
  recolorColor: string
}

export const DEFAULT_CLEANUP_SETTINGS: CleanupSettings = {
  viewMode: 'split',
  tool: 'magic',
  tolerance: 36,
  softness: 0.25,
  brushSize: 40,
  defringeStrength: 0.7,
  ghostOpacity: 60,
  matteOn: false,
  matteColor: '#ffffff',
  edgeShift: 0,
  feather: 2,
  defringeAmt: 0.9,
  trimPad: 8,
  recolorColor: '#ffffff',
}

export const loadCleanupSettings = (): CleanupSettings =>
  readLocal(LS_KEY, DEFAULT_CLEANUP_SETTINGS)

/** Debounced: the rail is sliders, and each fires per pointer move. */
export const saveCleanupSettings = debounce((settings: CleanupSettings) => {
  writeLocal(LS_KEY, settings)
}, 300)

/**
 * The stored working buffer for `assetKey`, decoded — or null when there is
 * none, or it belongs to a different image. Claimed, so re-entering the tab
 * later in the session starts from the live canvas rather than re-seeding it.
 *
 * Returns a thunk so the hook decodes it only after the source has decoded. The
 * claim itself happens at call time, so a second studio can't pick it up.
 */
export function cleanupSeed(assetKey: string): (() => Promise<ImageData | null>) | null {
  const stored: StoredCleanup | null = claim('cleanup')
  if (!stored || stored.assetKey !== assetKey) return null
  return async () => {
    const url = URL.createObjectURL(stored.working)
    try {
      // No size cap: rescaling would misalign them with the pristine snapshot
      // (the hook checks the dimensions before adopting them).
      return await getImageData(url, Infinity, null, { upscale: false })
    } catch {
      return null
    } finally {
      URL.revokeObjectURL(url)
    }
  }
}

/** Store the working buffer, or drop the slot when there is nothing to keep. */
export async function saveCleanupPixels(
  assetKey: string,
  snapshot: () => Promise<Blob | null>,
  modified: boolean,
): Promise<void> {
  if (!modified) {
    saveSlot(SLOTS.cleanup, null)
    return
  }
  const working = await snapshot()
  if (!working) return
  saveSlot(SLOTS.cleanup, { assetKey, working } satisfies Omit<StoredCleanup, 'v'>, 0)
}
