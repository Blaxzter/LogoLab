// Pure edits and messages behind the Cleanup canvas hook: every op mutates or reads an ImageData, no React.

import {
  alphaBounds,
  closeSeams,
  colorAt,
  defringe,
  despeckle,
  floodRemove,
  floodRestore,
  growMatte,
  featherAlpha,
  recolor,
  removeColor,
  shrinkMatte,
  type RemoveOptions,
} from './bgRemove.ts'
import type { AiProgress } from './aiRemove.ts'

/**
 * The active painting/marker tool.
 * - 'magic'   — contiguous flood-remove from the clicked pixel.
 * - 'color'   — global color-key remove of the clicked color.
 * - 'erase'   — soft brush that rubs out alpha (drag).
 * - 'restore' — soft brush that paints the pristine pixels back (drag).
 * - 'keep'    — guided marker: flood-restore the clicked region (one history step).
 * - 'remove'  — guided marker: flood-remove the clicked region (one history step).
 */
export type CleanupTool = 'magic' | 'color' | 'erase' | 'restore' | 'keep' | 'remove'

/** The single-click tools (everything but the erase/restore brushes). */
export type ClickTool = Exclude<CleanupTool, 'erase' | 'restore'>

/**
 * A guided keep/remove pin, stored normalized (0–1) to the image so it survives
 * a crop. The pin list is studio state (not persisted, not in undo); the type
 * lives with the tools because it is the hook's vocabulary.
 */
export type KeepRemoveMarker = { x: number; y: number; kind: 'keep' | 'remove' }

export type KeyColor = ReturnType<typeof colorAt>

/** True for a text-entry target, where Space and Ctrl+Z belong to the field. */
export function isFormField(t: EventTarget | null): boolean {
  return (
    t instanceof HTMLElement &&
    (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')
  )
}

/** True when two buffers are byte-identical (a missing buffer counts as equal). */
export function imageDataEqual(w: ImageData | null, p: ImageData | null): boolean {
  if (!w || !p) return true
  if (w.width !== p.width || w.height !== p.height) return false
  const a = w.data
  const b = p.data
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * Tidy a fresh removal: close the AA seam where this cut meets an
 * already-removed region and wipe specks the flood stranded. Both run before
 * defringe so they sample the raw background colors.
 */
export function finishRemoval(working: ImageData, key: KeyColor, defringeStrength: number): void {
  closeSeams(working)
  despeckle(working)
  if (defringeStrength > 0) defringe(working, key, defringeStrength)
}

/**
 * Apply a single-click tool at pixel (ix, iy) in place. `key` is the clicked
 * color (null for 'keep', which restores from `pristine` instead of keying).
 */
export function applyClickTool(
  tool: ClickTool,
  working: ImageData,
  pristine: ImageData | null,
  ix: number,
  iy: number,
  opts: RemoveOptions,
  defringeStrength: number,
): { affected: number; key: KeyColor | null } {
  if (tool === 'keep') {
    return { affected: pristine ? floodRestore(working, pristine, ix, iy, opts) : 0, key: null }
  }
  // magic / remove: contiguous flood-remove at the pixel; remove == magic
  // but seeded by a marker. color: global color key.
  const key = colorAt(working, ix, iy)
  const affected = tool === 'color' ? removeColor(working, key, opts) : floodRemove(working, ix, iy, opts)
  if (affected > 0) finishRemoval(working, key, defringeStrength)
  return { affected, key }
}

/** Status line after a single-click tool ran (`affected` 0 = nothing happened). */
export function clickToolStatus(tool: ClickTool, affected: number): string {
  if (tool === 'keep') {
    return affected > 0
      ? `Kept ${affected.toLocaleString()} px (restored region)`
      : 'Nothing to restore there — raise tolerance or pick a clearer spot.'
  }
  if (affected === 0) return 'Nothing within tolerance there — try raising tolerance.'
  if (tool === 'remove') return `Removed ${affected.toLocaleString()} px (marker region)`
  return `Removed ${affected.toLocaleString()} px (${tool === 'magic' ? 'contiguous' : 'by color'})`
}

/** The AI run's progress line. */
export function aiProgressLabel(p: AiProgress): string {
  return p.phase === 'download'
    ? `Downloading model${p.percent != null ? ` — ${p.percent}%` : '…'}`
    : 'Removing background…'
}

/**
 * Where an auto-trim would crop to, or why it can't: 'empty' (fully
 * transparent) or 'tight' (no pad and the alpha bbox is already the frame).
 */
export function trimBounds(
  working: ImageData,
  pad: number,
): { x: number; y: number; w: number; h: number } | 'empty' | 'tight' {
  const bounds = alphaBounds(working)
  if (!bounds) return 'empty'
  if (pad === 0 && bounds.x === 0 && bounds.y === 0 && bounds.w === working.width && bounds.h === working.height)
    return 'tight'
  return bounds
}

/** One edge-refine op: the in-place edit (returns affected px) plus its status lines. */
export interface EdgeOp {
  run: (working: ImageData, key: KeyColor | null) => number
  label: (affected: number) => string
  empty: string
}

/** The rail's edge-refine / recolor ops, each a single history step. */
export const edgeOps = {
  grow: (radius: number): EdgeOp => ({
    run: (w) => growMatte(w, radius),
    label: (n) => `Grew the edge by ${radius}px — ${n.toLocaleString()} px`,
    empty: 'Edge already filled — nothing to grow.',
  }),
  shrink: (radius: number): EdgeOp => ({
    run: (w) => shrinkMatte(w, radius),
    label: (n) => `Shrank the edge by ${radius}px — ${n.toLocaleString()} px`,
    empty: 'Nothing to shrink — the edge is already tight.',
  }),
  feather: (radius: number): EdgeOp => ({
    run: (w) => featherAlpha(w, radius),
    label: (n) => `Feathered the edge by ${radius}px — ${n.toLocaleString()} px`,
    empty: 'Nothing to feather.',
  }),
  defringe: (amount: number): EdgeOp => ({
    run: (w, key) => {
      // defringe doesn't report a count; treat any semi-transparent edge as
      // a change so the step commits (the op is a near-no-op otherwise).
      defringe(w, key ?? undefined, amount)
      return alphaBounds(w) ? 1 : 0
    },
    label: () => `Defringed the edges (strength ${amount.toFixed(1)})`,
    empty: 'Nothing to defringe — no soft edges.',
  }),
  recolor: (hex: string): EdgeOp => ({
    run: (w) => recolor(w, hex),
    label: (n) => `Recolored ${n.toLocaleString()} px to ${hex}`,
    empty: 'Nothing to recolor — the cutout is empty.',
  }),
}

/** Paint a buffer onto a fresh canvas of its size (null if no 2D context). */
export function imageDataToCanvas(data: ImageData): HTMLCanvasElement | null {
  const canvas = document.createElement('canvas')
  canvas.width = data.width
  canvas.height = data.height
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.putImageData(data, 0, 0)
  return canvas
}
