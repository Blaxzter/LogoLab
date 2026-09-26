import { useCallback, useRef, useState } from 'react'

/**
 * How long after a merged commit another one with the same key still counts as
 * the same gesture. Long enough that a slow, hesitant scrub stays one entry;
 * short enough that two deliberate picks (which need a dialog round-trip) don't
 * collapse into each other.
 */
const MERGE_MS = 800

/**
 * Undo/redo for a single immutable value.
 *
 * `set(next)` renders without recording — for live drag previews. `set(next,
 * true)` also commits: the previous *committed* value is pushed onto the undo
 * stack. A drag is therefore many `set(d)` while moving and one `set(final,
 * true)` on release, so undo returns to the pre-drag state, never to an
 * intermediate preview frame.
 *
 * `commitMerged(next, key)` is for gestures with no end event to commit on,
 * such as scrubbing a colour well. Previewing them would leave the last change
 * uncommitted (the next unrelated commit would snapshot from before it), and
 * committing each one adds an undo step per pointer move. A merged commit
 * replaces the previous merged commit with the same key, so the burst is one
 * entry and undo lands on the state before the scrub began.
 */
export function useHistory<T extends object>(limit = 80) {
  const [value, setValue] = useState<T | null>(null)
  /** Last committed value — what undo snapshots are cut from. */
  const stableRef = useRef<T | null>(null)
  const pastRef = useRef<T[]>([])
  const futureRef = useRef<T[]>([])
  /** The key and time of the last merged commit — what the next one merges into. */
  const mergeRef = useRef<{ key: string; at: number } | null>(null)
  // Stack mutations always pair with a setValue render, but the new value can
  // be identical (e.g. commit after preview); bump guarantees canUndo updates.
  const [, bump] = useState(0)

  const set = useCallback(
    (next: T, commit = false) => {
      if (commit) {
        mergeRef.current = null
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

  /**
   * Commit one frame of a continuous gesture. Consecutive calls with the same
   * `key`, less than MERGE_MS apart, share a single undo entry.
   */
  const commitMerged = useCallback(
    (next: T, key: string) => {
      const now = performance.now()
      const last = mergeRef.current
      const merges = last !== null && last.key === key && now - last.at < MERGE_MS
      if (!merges && stableRef.current !== null) {
        pastRef.current.push(stableRef.current)
        if (pastRef.current.length > limit) pastRef.current.shift()
      }
      mergeRef.current = { key, at: now }
      stableRef.current = next
      futureRef.current = []
      bump((n) => n + 1)
      setValue(next)
    },
    [limit],
  )

  /** New baseline (e.g. a fresh trace) — clears both stacks. */
  const reset = useCallback((next: T | null) => {
    pastRef.current = []
    futureRef.current = []
    mergeRef.current = null
    stableRef.current = next
    setValue(next)
    bump((n) => n + 1)
  }, [])

  const undo = useCallback(() => {
    mergeRef.current = null
    const prev = pastRef.current.pop()
    if (prev === undefined) return
    if (stableRef.current !== null) futureRef.current.push(stableRef.current)
    stableRef.current = prev
    setValue(prev)
    bump((n) => n + 1)
  }, [])

  const redo = useCallback(() => {
    mergeRef.current = null
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
    commitMerged,
    reset,
    undo,
    redo,
    canUndo: pastRef.current.length > 0,
    canRedo: futureRef.current.length > 0,
  }
}

export type History<T extends object> = ReturnType<typeof useHistory<T>>
