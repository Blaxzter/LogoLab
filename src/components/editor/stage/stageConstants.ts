// Stage chrome colours, screen-pixel hit radii and cursors, shared by the gestures and the overlays.

import type { Grip } from '../../../lib/editor/transform'

export const ACCENT = '#5b5bd6'
export const ACCENT_SEL = '#f25f2e'
export const GUIDE = '#e11d8f'
export const HALO = '#ffffff'

/** Hit radii in screen pixels (converted through `upp`). */
export const ANCHOR_PX = 9
export const HANDLE_PX = 8
export const SEGMENT_PX = 7
export const GRIP_PX = 9
export const ITEM_TOL_PX = 3
/** Movement before a pointerdown counts as a drag rather than a click. */
export const DRAG_THRESHOLD_PX = 3
/** Rotation grip offset above the transform box. */
export const ROTATE_OFFSET_PX = 22

/**
 * Per-grip cursors, so a scale handle over the artwork doesn't read as "move".
 */
export const GRIP_CURSOR: Record<Grip | 'rotate', string> = {
  nw: 'nwse-resize',
  se: 'nwse-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
  rotate: 'grab',
}

/** Coarse pointers (touch) need bigger everything. */
const COARSE = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches === true
export const HIT = COARSE ? 1.8 : 1
