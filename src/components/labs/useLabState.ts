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

  const patch = useCallback(
    (p: Partial<T>) =>
      setState((prev) => {
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
