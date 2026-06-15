import { useEffect } from 'react'

// Module-level refcount so multiple simultaneously-open sheets (e.g. a sheet
// opened from another sheet) don't unlock the body until the LAST one closes.
let lockCount = 0
let savedOverflow = ''

/**
 * Locks background scroll on <body> while `active` is true. Refcounted, so
 * nested/stacked sheets compose correctly — the lock releases only when every
 * caller has unlocked. No-op on the server / before mount.
 */
export function useBodyScrollLock(active: boolean) {
  useEffect(() => {
    if (!active) return
    if (lockCount === 0) {
      savedOverflow = document.body.style.overflow
      document.body.style.overflow = 'hidden'
    }
    lockCount += 1
    return () => {
      lockCount -= 1
      if (lockCount === 0) document.body.style.overflow = savedOverflow
    }
  }, [active])
}
