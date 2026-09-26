// Whether Space is held down (Space-to-pan), tracked at the window.

import { useEffect, useState } from 'react'

export function useSpaceHeld(): boolean {
  const [spaceHeld, setSpaceHeld] = useState(false)

  // Space-to-pan. Tracked at the window so it works wherever the pointer is,
  // and released on blur so alt-tabbing away can't leave it stuck on.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !isTypingTarget(e.target)) {
        e.preventDefault()
        setSpaceHeld(true)
      }
    }
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpaceHeld(false)
    }
    const blur = () => setSpaceHeld(false)
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
  }, [])

  return spaceHeld
}

/** Focus is in a text field, where Space (and every shortcut) belongs to the field. */
export function isTypingTarget(t: EventTarget | null): boolean {
  return (
    t instanceof HTMLElement &&
    (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')
  )
}
