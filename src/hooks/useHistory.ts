import { useCallback, useRef, useState } from 'react'

/**
 * Undo/redo for a single immutable value.
 *
 * `set(next)` renders without recording — for live drag previews. `set(next,
 * true)` also commits: the previous *committed* value is pushed onto the undo
 * stack. A drag is therefore many `set(d)` while moving and one `set(final,
 * true)` on release, so undo returns to the pre-drag state, never to an
 * intermediate preview frame.
 */
export function useHistory<T extends object>(limit = 80) {
  const [value, setValue] = useState<T | null>(null)
  /** Last committed value — what undo snapshots are cut from. */
  const stableRef = useRef<T | null>(null)
  const pastRef = useRef<T[]>([])
  const futureRef = useRef<T[]>([])
  // Stack mutations always pair with a setValue render, but the new value can
  // be identical (e.g. commit after preview); bump guarantees canUndo updates.
  const [, bump] = useState(0)

  const set = useCallback(
    (next: T, commit = false) => {
      if (commit) {
        if (stableRef.current !== null) {
          pastRef.current.push(stableRef.current)
          if (pastRef.current.length > limit) pastRef.current.shift()
        }
        stableRef.current = next
        futureRef.current = []
        bump((n) => n + 1)
      }
      setValue(next)
    },
    [limit],
  )

  /** New baseline (e.g. a fresh trace) — clears both stacks. */
  const reset = useCallback((next: T | null) => {
    pastRef.current = []
    futureRef.current = []
    stableRef.current = next
    setValue(next)
    bump((n) => n + 1)
  }, [])

  const undo = useCallback(() => {
    const prev = pastRef.current.pop()
    if (prev === undefined) return
    if (stableRef.current !== null) futureRef.current.push(stableRef.current)
    stableRef.current = prev
    setValue(prev)
    bump((n) => n + 1)
  }, [])

  const redo = useCallback(() => {
    const next = futureRef.current.pop()
    if (next === undefined) return
    if (stableRef.current !== null) pastRef.current.push(stableRef.current)
    stableRef.current = next
    setValue(next)
    bump((n) => n + 1)
  }, [])

  return {
    value,
    set,
    reset,
    undo,
    redo,
    canUndo: pastRef.current.length > 0,
    canRedo: futureRef.current.length > 0,
  }
}

export type History<T extends object> = ReturnType<typeof useHistory<T>>
