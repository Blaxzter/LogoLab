import { useEffect, useState } from 'react'

/**
 * Subscribes to a CSS media query. For the few decisions CSS can't make on its
 * own — coercing a view mode away from a desktop-only split pane, or deciding
 * whether a tooltip would merely repeat a label the layout is already showing.
 *
 * Seeded synchronously from `matchMedia` so the first painted frame is already
 * right; a `useEffect`-only read would render the wide layout and snap.
 */
export function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches)

  useEffect(() => {
    const mq = window.matchMedia(query)
    const onChange = () => setMatches(mq.matches)
    onChange()
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [query])

  return matches
}

/**
 * Tracks whether the viewport is below Tailwind's `md` breakpoint (the line at
 * which the studios switch from their three-column desktop layout to the
 * canvas-first mobile layout).
 */
export function useIsMobile(query = '(max-width: 767px)') {
  return useMediaQuery(query)
}
