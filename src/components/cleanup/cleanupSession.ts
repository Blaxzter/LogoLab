// What the cleanup studio remembers across a reload.
//
// Two halves, for the same reason as everywhere else in this app: the tool
// settings go to localStorage (read synchronously while the studio mounts), and
// the PIXELS go to IndexedDB.
//
// The pixels are the point. A cutout that has not been Applied yet exists only in
// the studio's working buffer — the store still holds the untouched upload — so
// before this, ten minutes of brushwork was one refresh away from gone, and it
// was the one kind of work in the app with no way to get it back.

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
 * Returns a thunk because the hook wants to resolve this AFTER it has decoded
 * the source, and only then: a decode we never use is a decode we shouldn't pay
 * for. The claim still happens eagerly, at call time, so it is not left sitting
 * in the boot payload for a second studio to pick up.
 */
export function cleanupSeed(assetKey: string): (() => Promise<ImageData | null>) | null {
  const stored: StoredCleanup | null = claim('cleanup')
  if (!stored || stored.assetKey !== assetKey) return null
  return async () => {
    const url = URL.createObjectURL(stored.working)
    try {
      // No cap: these are the exact pixels we stored, and rescaling them would
      // land them on a different lattice than the pristine snapshot they have to
      // line up with (the hook checks the dimensions before adopting them).
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
