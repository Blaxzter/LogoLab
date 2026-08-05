// Icon-sheet splitting — the types shared by detection, cropping and the UI.
//
// A "sheet" is one raster holding N icons laid out on a common background: the
// thing an image model hands you when you ask for an icon set. Splitting it is a
// separate problem from tracing, and it stays separate: everything here works on
// plain pixels and produces BOXES, and the existing vectorizer runs unchanged on
// each crop.

/** Anything shaped like a browser `ImageData` (the Node harness decodes into this too). */
export interface ImageDataLike {
  width: number
  height: number
  /** Row-major RGBA, 8 bits per channel. */
  data: Uint8ClampedArray
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * What a tile is: `icon` gets extracted, `label` is the caption text under an
 * icon (sheets from image models are usually annotated) and `noise` is a speck
 * too small to be either. Only `icon` is selected by default, but the others are
 * kept so the UI can show what it decided and let you overrule it — a "label"
 * misfire would otherwise look like a silently missing icon.
 */
export type TileKind = 'icon' | 'label' | 'noise'

export interface SheetTile {
  id: string
  /** The crop box in SOURCE pixels — padded, and squared when `square` is on. */
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
   * Undefined = pick it automatically from the gap-scale plateau (recommended:
   * it is the one number that actually decides "one icon or two").
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

export interface SheetBackground {
  r: number
  g: number
  b: number
  a: number
  /** Fraction of the sheet within `threshold` of this colour. */
  coverage: number
  /** The sheet is transparent and alpha alone separates the icons. */
  transparent: boolean
  /** The border ring agreed with itself — a plain, flat sheet background. */
  uniform: boolean
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
