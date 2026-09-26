// Colours and screen-px hit radii shared by the node-edit canvas and its overlays.

export const ACCENT = "#5b5bd6";
/** Selected anchor fill — warm hue that contrasts the indigo outline/stroke. */
export const ACCENT_SEL = "#f25f2e";
/** White halo/ring colour, keeps the overlay legible over any artwork. */
export const HALO = "#ffffff";
/** Region-marker pin colour (emerald) — distinct from the indigo/orange edit accents. */
export const MARKER = "#10b981";
export const FLAT_MARKER = "#f59e0b"; // amber — "flat colour" markers
export const REMOVE_MARKER = "#f43f5e"; // rose — "remove & heal" markers
/** Screen-px movement before a pointerdown counts as a drag (not a click). */
export const DRAG_THRESHOLD_PX = 3;
/** Max screen-px distance from a segment for double-click node insertion. */
export const INSERT_MAX_PX = 12;
/** Screen-px radius for double-clicking an anchor (toggle corner/smooth). */
export const ANCHOR_HIT_PX = 8;
/** Screen-px radius treated as "on a handle dot" (dblclick no-op). */
export const HANDLE_HIT_PX = 7;
/** Screen-px radius for clicking an existing region marker to remove it. */
export const MARKER_HIT_PX = 11;
/** Coarse pointer (touch): enlarge all hit targets so fingers can grab the small
 *  anchors/handles. 1× on a mouse, so desktop precision is unchanged. */
const COARSE =
    typeof window !== "undefined" &&
    window.matchMedia?.("(pointer: coarse)").matches === true;
export const HIT = COARSE ? 1.7 : 1;
