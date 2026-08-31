import { useCallback, useState } from 'react'

/**
 * localStorage-persisted view state for a lab — box size, heat scale, toggles.
 * Replaces the three hand-rolled `load()` / `save()` pairs (goldenView, truthView,
 * junctionTest), which all had the same shape: spread the defaults under whatever
 * was stored, so a newly added key doesn't come back undefined for existing users.
 */
export function useLabState<T extends object>(key: string, defaults: T): [T, (patch: Partial<T>) => void] {
  const [state, setState] = useState<T>(() => {
    try {
      return { ...defaults, ...(JSON.parse(localStorage.getItem(key) ?? '{}') as Partial<T>) }
    } catch {
      return { ...defaults }
    }
  })

  // A patch that changes nothing returns the SAME object, so React bails out of the render.
  // Callers legitimately fire no-op patches on a hot path — every lab with paging resets to
  // `page: 0` on each keystroke of the corpus search, and page 0 is where you already were —
  // and a fresh `{...prev}` there would re-render the whole corpus (and write localStorage)
  // per character typed.
  const patch = useCallback(
    (p: Partial<T>) =>
      setState((prev) => {
        if (Object.keys(p).every((k) => Object.is(prev[k as keyof T], p[k as keyof T]))) return prev
        const next = { ...prev, ...p }
        try {
          localStorage.setItem(key, JSON.stringify(next))
        } catch {
          /* private mode / quota — the view still works, it just won't remember */
        }
        return next
      }),
    [key],
  )

  return [state, patch]
}
