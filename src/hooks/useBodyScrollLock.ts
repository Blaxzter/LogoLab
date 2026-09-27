import { useEffect } from 'react'

// Module-level refcount so stacked sheets keep the body locked until the last
// one closes.
let lockCount = 0
let savedOverflow = ''

/** Locks background scroll on <body> while `active` is true (refcounted). */
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
