import { useEffect, useState } from 'react'

/**
 * Tracks whether the viewport is below Tailwind's `md` breakpoint (the line at
 * which the studios switch from their three-column desktop layout to the
 * canvas-first mobile layout). Used for the few decisions CSS can't make on its
 * own — e.g. coercing the view mode away from the desktop-only split pane.
 */
export function useIsMobile(query = '(max-width: 767px)') {
  const [matches, setMatches] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches,
  )

  useEffect(() => {
    const mq = window.matchMedia(query)
    const onChange = () => setMatches(mq.matches)
    onChange()
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [query])

  return matches
}
