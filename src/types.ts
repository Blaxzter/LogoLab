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
  /** Max number of fill colors to quantize to (color mode), 2–24. */
  colors: number
  /** 0 (crisp corners, node-dense) → 100 (very smooth, sparse). Drives potrace curve fitting. */
  smoothing: number
  /** 0 (keep every speck) → 100 (aggressive noise suppression). Drives speckle & color cleanup. */
  despeckle: number
  /** Mono threshold 0–255 (mono mode). */
  threshold: number
  /** Drop the detected background layer for transparent output. */
  removeBackground: boolean
  /**
   * Fit smooth color gradients (color mode): regions whose source pixels follow
   * a linear/radial ramp export as a real SVG gradient instead of a flat fill.
   * Defaults to on when omitted.
   */
  gradients?: boolean
  /**
   * Tracer backend. 'potrace' = the classic bilevel WASM tracer (default;
   * seamless on stacked multi-color gradients). 'crisp' = sub-pixel
   * marching-squares + Schneider Bézier fitting — cleaner, lower-node curves,
   * best for line-art / solid-shape logos.
   */
  engine?: 'potrace' | 'crisp'
  /**
   * Shape-beautification fidelity tolerance (px): how far a traced contour may
   * drift from the source when snapping it to a perfect circle/ellipse/line or
   * aligning concentric/equal shapes. A snap is accepted only if its max
   * deviation stays under this. 0 disables beautification entirely. Defaults to
   * ~1.5 when omitted. Higher = more regular geometry, less PNG-faithful.
   */
  fidelity?: number
}
