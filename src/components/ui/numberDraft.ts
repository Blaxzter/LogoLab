// What a NumberField's typed text commits as. Its own `.ts` so a test can reach
// it (node strips types from `.ts`, not `.tsx`).

/**
 * The number `draft` stands for, or null when it should revert to the shown
 * value: not a number, out of range, or BLANK. `Number('')` is 0, so without the
 * blank check clearing the X field and tabbing away moved the shape to x = 0 (and
 * a cleared stroke width erased the stroke) instead of putting the value back.
 */
export function parseNumberDraft(draft: string, min?: number, max?: number): number | null {
  if (draft.trim() === '') return null
  const n = Number(draft)
  if (!Number.isFinite(n)) return null
  if (min !== undefined && n < min) return null
  if (max !== undefined && n > max) return null
  return n
}
