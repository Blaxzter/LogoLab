// Types shared by icon-sheet detection, cropping and the UI. A sheet is one
// raster holding N icons on a common background; splitting produces boxes, and
// the vectorizer runs unchanged on each crop.

// Pixel and paper types live in ink.ts; re-exported under the sheet names.
import type { PaperColor } from '../traceInput/ink.ts'
export type { ImageDataLike } from '../traceInput/ink.ts'
export type SheetBackground = PaperColor

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * What a tile is: `icon` gets extracted, `label` is caption text, `noise` is a
 * speck. Only icons are selected by default; the others are kept so the UI can
 * show the decision and let the user overrule it.
 */
export type TileKind = 'icon' | 'label' | 'noise'

export interface SheetTile {
  id: string
  /** The crop box in source pixels, padded and squared when `square` is on. */
  box: Rect
  /** Tight bounding box of the ink itself, before padding/squaring. */
  ink: Rect
  /** Ink pixel count (source-pixel estimate) — drives the noise/labels split. */
  inkArea: number
  kind: TileKind
  /** Grid position, row-major from the top-left. -1 when no grid was inferred. */
  row: number
  col: number
}

export interface DetectOptions {
  /**
   * Colour distance (0–255, max-channel) from the sheet background at which a
   * pixel counts as ink. Low = picks up faint anti-aliasing and JPEG mush; high
   * = drops pale icons into the background.
   */
  threshold?: number
  /** Long-side resolution the mask is analysed at. Detection cost is O(pixels). */
  detectSize?: number
  /**
   * Gap (in source px) at which two ink blobs are considered the same icon.
   * Undefined = pick it automatically from the gap-scale plateau.
   */
  gap?: number
  /** Padding around the ink, as a fraction of the tile's long side. */
  padding?: number
  /** Force square crops (what an icon export almost always wants). */
  square?: boolean
  /** Give every tile the same box size, so relative icon scale survives export. */
  uniform?: boolean
  /** Drop caption text under icons. */
  dropLabels?: boolean
  /** Blobs smaller than this fraction of the median icon area are noise. */
  noiseFraction?: number
}

export interface SheetGrid {
  rows: number
  cols: number
  /** Centre-to-centre spacing in source px (0 when a single row/column). */
  pitchX: number
  pitchY: number
}

export interface SheetDetection {
  tiles: SheetTile[]
  background: SheetBackground
  /** Non-null when the icons landed on a regular lattice. */
  grid: SheetGrid | null
  /** The grouping gap actually used, in source px. */
  gap: number
  /** Detection downscale (source px × scale = mask px). */
  scale: number
  /** Human-readable notes — surfaced in the UI so a bad split is explainable. */
  warnings: string[]
}
