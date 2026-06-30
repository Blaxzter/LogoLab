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
  /** 0 (crisp corners, node-dense) → 100 (very smooth, sparse). Drives potrace curve fitting. */
  smoothing: number
  /** 0 (keep every speck) → 100 (aggressive noise suppression). Drives speckle & color cleanup. */
  despeckle: number
  /**
   * Region detail (color mode), 0–100. 0 = balanced (the default) — similar
   * colours merge into few macro-regions. Higher tightens the segmentation merge
   * (colour-difference + union-fit thresholds) so finer/subtler regions survive —
   * e.g. the blends where translucent shapes overlap. The tradeoff: high values
   * can fragment smooth gradients into flat bands and are slower. Omitted ⇒ 0.
   */
  regionDetail?: number
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
   * Tracer backend. 'planar' = the shared-edge planar subdivision (default for
   * color): adjacent regions share one boundary curve, so there is no overlap
   * and no hairline seam, and shared boundaries are jointly editable. 'crisp' =
   * sub-pixel marching-squares + Schneider Bézier fitting per region (overlapping
   * stacked masks). 'potrace' = the classic bilevel WASM tracer.
   */
  engine?: 'potrace' | 'crisp' | 'planar'
  /**
   * Trace detail / resolution preset. 'balanced' (default) uses the adaptive cap
   * (flat art 2048, gradient/photo 1024). 'high' raises the FLAT cap to 4096 for
   * crisper edges on large sources, at ~the square of the cost; gradient/photo is
   * unchanged (keeps the Step-3c freeze guard). No effect when the source is
   * already ≤ the balanced cap — rasters are never upscaled. Omitted ⇒ 'balanced'.
   */
  traceDetail?: 'balanced' | 'high'
  /**
   * Flat-art segmentation strategy. When gradients are OFF, the default is
   * PALETTE-FIRST (paletteSegment.ts): pick the dominant colours, snap every pixel
   * to the nearest, so anti-alias transitions never become their own blend region.
   * Set false to fall back to the Mumford–Shah smoothness segmenter for flat art.
   * Ignored when gradients are on (MS always owns gradient art). Omitted ⇒ palette.
   */
  flatPalette?: boolean
  /**
   * User-LOCKED flat palette (color mode, gradients OFF). When set, the
   * palette-first segmenter skips automatic colour extraction and snaps every pixel
   * to the nearest of THESE colours — the user owns both the colours (emitted as
   * exact hex) and the count. A locked palette also bypasses the automatic
   * coverage / ≤14-colour gates (the user has decided this art is flat). Omitted ⇒
   * the palette is extracted automatically and snapped to each region's true design
   * hex. Ignored when gradients are on. Seed it from the auto palette and edit.
   *
   * Each entry may carry an optional alpha 0–255 (undefined ⇒ opaque): pixels snap
   * to the nearest colour in RGBA space, and a translucent entry paints its region
   * with that `fill-opacity` (planar engine). The auto path fills `a` from each
   * region's alpha mode, so a flat semi-transparent region round-trips its opacity.
   */
  palette?: { r: number; g: number; b: number; a?: number }[]
  /**
   * Shape-beautification fidelity tolerance (px): how far a traced contour may
   * drift from the source when snapping it to a perfect circle/ellipse/line or
   * aligning concentric/equal shapes. A snap is accepted only if its max
   * deviation stays under this. 0 disables beautification entirely. Defaults to
   * ~1.5 when omitted. Higher = more regular geometry, less PNG-faithful.
   */
  fidelity?: number
  /**
   * User-placed region markers ("seeds") for segmentation, in NORMALIZED [0,1]
   * image coordinates (resolution-independent: correct at any raster size).
   * Marker-watershed semantics — a marker means "keep a distinct region here":
   * two regions that contain different markers never merge, and a marked region
   * is never absorbed away. Unmarked areas merge exactly as without markers. To
   * split a translucent overlap from a neighbouring shape, mark BOTH. Omitted /
   * empty ⇒ byte-identical to no markers.
   */
  /**
   * User-placed region markers (segmentation seeds), NORMALIZED [0,1] coords. Each
   * marker keeps its region distinct (a seeded split settles the boundary on the
   * colour ridge). A marker tagged `flat: true` ADDITIONALLY pins its region to its
   * pre-merge flat form — excluded from the gradient field-merge and painted one
   * solid colour ("this section is flat, kept its own thing"). The two tags are
   * split into the segmenter's `markers` / `flatMarkers` by `segmentOptionsFor`.
   * A marker tagged `remove: true` instead DISSOLVES the section under it: at trace
   * time (planar engine) its connected region is removed and its bordering colours
   * grow into the freed area (nearest-neighbour split — `applyRemoveMarkers`), so
   * the gap heals instead of leaving a hole. Omitted / empty ⇒ no markers.
   */
  markers?: { x: number; y: number; flat?: boolean; remove?: boolean }[]
  /**
   * Translucent layer decomposition (V6, color mode). When the segmentation has
   * recovered overlap-shaped regions (via markers or Region detail), try to
   * represent them as a few STACKED TRANSLUCENT shapes (N circles at one opacity
   * over the background) instead of opaque flat bands — the source's true form,
   * with the fewest, most editable elements. Purely additive and gated: it is
   * emitted only when it beats the opaque rendering, and is a NO-OP (byte-
   * identical output) when there are no overlap regions or no markers/detail.
   * Defaults to on when omitted; set false to force opaque bands.
   */
  layeredDecomposition?: boolean
  /**
   * Advanced override of the planar curve-fit tunables (epsilon / line vs cubic
   * cost / corner angle / pre-smoothing). Merged over the smoothing-derived
   * defaults. Used by the crispness study to A/B faceting; omitted ⇒ defaults.
   */
  planarFit?: Partial<import('./lib/trace/planarFit').PlanarFitOptions>
}
