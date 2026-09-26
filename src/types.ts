// Shared domain types for LogoLab.

export type PreviewTheme = 'light' | 'dark'

/** Shape of the "card" / icon background that sits behind the logo. */
export type IconShape = 'rounded' | 'circle' | 'square'

/** The uploaded logo asset and its intrinsic metadata. */
export interface LogoAsset {
  /** Object URL / data URL usable as <img src> / mask-image. Null when nothing loaded. */
  src: string | null
  /** The pristine uploaded source, so edits (e.g. background removal) can be reset. */
  originalSrc: string | null
  fileName: string | null
  mime: string | null
  /** Intrinsic pixel dimensions (for raster) or viewBox-derived size (for svg). */
  naturalWidth: number
  naturalHeight: number
  isSvg: boolean
  /** Raw SVG markup when an SVG was uploaded (used for export/vectorize passthrough). */
  svgText: string | null
}

/**
 * Appearance settings the user tweaks; consumed by <LogoMark> and every scene.
 *
 * The "card" is the colored backplate behind the logo. It is what solves the
 * "white line-art logo needs a background card" problem: enable it and pick a
 * fill color. In icon contexts (iOS/Android/app store) a card is always drawn
 * (icons can't be transparent); in flat contexts (nav bars, favicons) the card
 * is only drawn when `cardInFlat` is true.
 */
export interface Appearance {
  /** Logo scale inside its safe area: fraction of available box, 0.3–1. */
  scale: number
  /** Safe-zone inset as a percentage of the box (margin around the logo), 0–35. */
  padding: number

  /** Card / icon background. */
  cardColor: string
  cardShape: IconShape
  /** Corner radius as a percentage of size, applies to `rounded` shape, 0–50. */
  cardRadius: number
  cardShadow: boolean
  /** Draw the card backplate even in flat (non-icon) contexts like nav bars. */
  cardInFlat: boolean

  /** Recolor a (typically monochrome) logo to a single color via alpha mask. */
  tintEnabled: boolean
  tintColor: string
  /** Quick CSS invert — handy to flip a dark logo for dark contexts. */
  invert: boolean
}

export interface Environment {
  /** Drives the light/dark wallpaper & chrome of the preview scenes. */
  theme: PreviewTheme
  /** Background color used by flat scenes (desktop page, splash, etc.). */
  pageBg: string
  /** Brand label rendered inside mockups (app name, nav wordmark, etc.). */
  brandName: string
}

/** A single PWA export target (one rendered PNG, or a group like favicon.ico). */
export interface ExportTarget {
  id: string
  label: string
  /** Output pixel size (square). */
  size: number
  /** Filename to write into the zip. */
  fileName: string
  /** Maskable icons need extra safe-zone padding and a full-bleed background. */
  maskable: boolean
  /** Logical grouping for the target-selection UI. */
  group: 'favicon' | 'apple' | 'android' | 'maskable' | 'windows' | 'custom'
  /** Whether the target is selected for export. */
  enabled: boolean
}

/** Options passed to the canvas icon renderer used by the export pipeline. */
export interface RenderIconOptions {
  size: number
  /** Background fill; use 'transparent' to keep alpha. */
  background: string
  shape: IconShape
  /** Corner radius percentage (rounded shape). */
  radiusPct: number
  /** Safe-zone inset percentage. */
  paddingPct: number
  /** Logo scale fraction. */
  scale: number
  tintColor?: string | null
  invert?: boolean
}

/** Vectorization configuration for the raster → SVG tracing pipeline. */
export interface VectorizeOptions {
  mode: 'color' | 'mono'
  /** 0 (crisp corners, node-dense) to 100 (very smooth, sparse). Drives curve fitting. */
  smoothing: number
  /** 0 (keep every speck) to 100 (aggressive noise suppression). Drives speckle and colour cleanup. */
  despeckle: number
  /**
   * Region detail (color mode), 0–100, default 0. Higher tightens the
   * segmentation merge so finer regions survive (e.g. translucent overlaps), at
   * the cost of speed and of fragmenting smooth gradients into bands.
   */
  regionDetail?: number
  /** Mono threshold 0–255 (mono mode). */
  threshold: number
  /**
   * Mono: the ink is lighter than the paper, so pixels above the cut become
   * solid instead of pixels below it. Default off.
   */
  invert?: boolean
  /** Drop the detected background layer for transparent output. */
  removeBackground: boolean
  /**
   * Color mode: regions whose pixels follow a linear/radial ramp export as an
   * SVG gradient instead of a flat fill. Default on.
   */
  gradients?: boolean
  /**
   * Vestigial: the planar tracer is the only engine. Kept so stored options and
   * existing option literals still parse; don't remove it.
   */
  engine?: 'planar'
  /**
   * Resolution preset. 'balanced' (default) caps flat art at 2048 and gradient
   * art at 1024; 'high' raises the flat cap to 4096 at roughly the square of the
   * cost. Only affects sources larger than the balanced cap.
   */
  traceDetail?: 'balanced' | 'high'
  /**
   * Enlargement before tracing. UI-side policy (read by the studio, the icon
   * sheet and the MCP server, never by src/lib/trace).
   *  - 'auto' (default): a mono raster that is small or has thin ink is
   *    enlarged bilinearly (`monoTraceScale` in traceCaps.ts). Colour and SVG
   *    sources are left alone.
   *  - 'ai': in-browser AI super-resolution for small rasters (aiUpscale.ts).
   *  - 'off': trace the raster as it is.
   */
  upscale?: 'off' | 'auto' | 'ai'
  /**
   * Flat-art segmentation (gradients off). Default is palette-first
   * (paletteSegment.ts): snap every pixel to the nearest dominant colour so
   * anti-aliasing never becomes its own region. False uses the Mumford–Shah
   * segmenter instead. Ignored when gradients are on.
   */
  flatPalette?: boolean
  /**
   * User-locked flat palette (color mode, gradients off). Every pixel snaps to
   * the nearest of these colours, emitted as exact hex, and the automatic
   * flat-art gates are bypassed. Omitted: extracted automatically. Ignored when
   * gradients are on.
   *
   * `a` is an optional alpha 0–255 (default opaque): snapping happens in RGBA
   * and a translucent entry paints its region with that `fill-opacity`.
   */
  palette?: { r: number; g: number; b: number; a?: number }[]
  /**
   * Beautification tolerance (px): the maximum deviation a snap to a perfect
   * circle/ellipse/line, or an alignment, may introduce. 0 disables
   * beautification. Default ~1.5.
   */
  fidelity?: number
  /**
   * User-placed segmentation seeds in normalized [0,1] image coordinates. A
   * marker keeps its region distinct: regions holding different markers never
   * merge. `flat: true` also keeps the region out of the gradient merge and
   * paints it one solid colour. `remove: true` instead dissolves the region and
   * lets its neighbours grow into the gap (`applyRemoveMarkers`).
   */
  markers?: { x: number; y: number; flat?: boolean; remove?: boolean }[]
  /** Vestigial: no tracer reads it. Kept so stored options still parse. */
  layeredDecomposition?: boolean
  /** Advanced override of the planar curve-fit tunables, merged over the smoothing-derived defaults. */
  planarFit?: Partial<import('./lib/trace/planarFit').PlanarFitOptions>
  /** Advanced override of the flat-palette segmenter's tunables (flat art only), merged over the defaults. */
  paletteSegment?: Partial<import('./lib/trace/paletteSegment').PaletteSegmentOptions>
  /**
   * Advanced override of the smoothness segmenter's tunables and its devtest
   * observer (`onPair`), merged last over the dial-derived options. Gradients-on
   * path only.
   */
  segment?: Partial<import('./lib/trace/segment').SegmentOptions>
  /**
   * Experimental (color mode, gradients off). A posterized background ramp
   * splits every foreground outline it touches into band junctions. When true,
   * the border-connected bands one gradient explains are merged into a single
   * region painted with that gradient. Default off.
   */
  backgroundGradient?: boolean
}
