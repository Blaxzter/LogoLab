// Documentation for the vectorize controls: each knob's short hint, long
// explanation, the example that best shows it, and the before/after variants
// its info dialog renders.
//
// Framework-free (type-only imports) so the build-time preview generator
// (bench/genControlPreviews.ts) and ControlInfoDialog share the same
// descriptors.

import type { VectorizeOptions } from '../../types'

/** A bundled example the headless generator can rebuild without a browser (`outline`
 *  has no PNG twin and serves a live-only control, traced in the browser). */
export type ExampleKey = 'bloom' | 'nebula' | 'petals' | 'outline'

/** A synthesized demo scene (see bench/previewScenes.ts). */
export type SceneName = 'smoothing' | 'despeckle' | 'fidelity' | 'threshold' | 'overlaps'

/**
 * Where a control's preview imagery comes from: a bundled logo (shown as-is and
 * loaded by the generator) or a purpose-built synthetic scene (rasterized by the
 * generator, which also emits an SVG thumbnail of the source).
 */
export type ExampleSource = { kind: 'bundled'; key: ExampleKey; file: string } | { kind: 'synthetic'; scene: SceneName }

export interface ControlVariant {
  /** Short caption under the preview ("None" / "Medium" / "High", "Off" / "On"…). */
  label: string
  /** Patch applied over the control's base options to produce this variant. */
  patch: Partial<VectorizeOptions>
}

export interface ControlDoc {
  /** Stable id — also the key into the generated previews manifest. */
  id: string
  /** Field label as shown in the panel. */
  label: string
  /** One-line hint shown under the field (kept in sync with TraceControls). */
  hint: string
  /** Longer plain-language explanation shown in the info dialog. */
  blurb: string
  /** Which example best demonstrates this control. */
  example: ExampleSource
  /** Base options shared by every variant (e.g. Threshold needs mono mode). */
  baseOpts?: Partial<VectorizeOptions>
  /** The before/after spread rendered in the dialog. */
  variants: ControlVariant[]
  /**
   * No precomputed grid: the dialog traces the variants live in the browser
   * when it opens.
   */
  liveOnly?: boolean
  /**
   * Suppress the "My image" tab — for controls whose variants only make sense on
   * the bundled scene (e.g. markers placed at fixed coordinates).
   */
  exampleOnly?: boolean
}

const bundled = (key: ExampleKey, file: string): ExampleSource => ({ kind: 'bundled', key, file })
const synthetic = (scene: SceneName): ExampleSource => ({ kind: 'synthetic', scene })

export const CONTROL_DOCS: ControlDoc[] = [
  {
    id: 'smoothing',
    label: 'Smoothing',
    hint: 'Higher values trade small detail for smoother curves.',
    blurb:
      'How much the pixel staircase along each edge is smoothed before curves are fitted to it. None follows every pixel: lots of nodes, with jagged edges kept as they are. Medium balances clean curves against accuracy. High melts small wiggles into long, sweeping Bézier curves with the fewest nodes, but fine detail and subtle bends soften. The fit itself always stays within one pixel; this only changes how much the edge is smoothed first.',
    example: synthetic('smoothing'),
    variants: [
      { label: 'None', patch: { smoothing: 0 } },
      { label: 'Medium', patch: { smoothing: 50 } },
      { label: 'High', patch: { smoothing: 100 } },
    ],
  },
  {
    id: 'despeckle',
    label: 'Despeckle',
    hint: 'Removes anti-aliasing slivers and stray specks.',
    blurb:
      'Removes tiny stray regions before tracing. None keeps every speck, including the anti-aliasing slivers along edges: accurate, but messy and heavy on nodes. Medium drops stray dots and fringe. High also merges small areas and near-identical colours. That gives the cleanest output, but it can swallow small details you meant to keep, like dots, thin outlines or punctuation.',
    example: synthetic('despeckle'),
    variants: [
      { label: 'None', patch: { despeckle: 0 } },
      { label: 'Medium', patch: { despeckle: 50 } },
      { label: 'High', patch: { despeckle: 100 } },
    ],
  },
  {
    id: 'fidelity',
    label: 'Fidelity',
    hint: 'Snaps near-circles, near-lines and shared centres to exact shapes.',
    blurb:
      'After tracing, near-circles, near-lines and shared centres are snapped to perfect shapes, but only when the snap moves the outline by less than this many pixels. Off keeps the traced outline exactly as it came out. The default (1.5px) straightens the obvious circles and lines. High (6px) lets shapes move further, which suits clean, regular icons; on organic artwork it can make shapes too regular.',
    example: synthetic('fidelity'),
    variants: [
      { label: 'Off', patch: { fidelity: 0 } },
      { label: 'Default', patch: { fidelity: 1.5 } },
      { label: 'High', patch: { fidelity: 6 } },
    ],
  },
  {
    id: 'regionDetail',
    label: 'Region detail',
    hint: 'How finely the image is split into shapes.',
    blurb:
      'How finely the image is split into shapes before tracing. Auto merges similar colours into a few large regions, which suits smooth gradients. Medium and High keep subtler regions as shapes of their own, like the soft blend where translucent shapes overlap. Higher values recover those overlaps but can break a smooth gradient into flat bands, and they trace more slowly. To keep just one area, place a region marker there instead of raising this for the whole image.',
    example: bundled('petals', 'petals.png'),
    baseOpts: { mode: 'color' },
    variants: [
      { label: 'Auto', patch: { regionDetail: 0 } },
      { label: 'Medium', patch: { regionDetail: 50 } },
      { label: 'High', patch: { regionDetail: 100 } },
    ],
  },
  {
    id: 'markers',
    label: 'Mark regions',
    hint: 'Pin a spot to keep it separate, or to make it flat.',
    blurb:
      'A region marker tells the tracer how to treat one spot when it splits the image into regions. Separate keeps a distinct shape there: two regions with different markers never merge, and a marked region is never absorbed. Use it to recover something the automatic merge would swallow, like the soft blend where translucent shapes overlap. Flat does the same and also paints the region one solid colour instead of a fitted gradient. If the tracer has fused two flat sections into one “weird gradient”, mark each side as Flat to get two clean solids. Turn on Place markers, pick the kind, then click the image (either pane) to drop a marker; click a marker to remove it. To split a region from its neighbour, mark both sides. Areas without markers trace exactly as before.',
    example: synthetic('overlaps'),
    baseOpts: { mode: 'color' },
    exampleOnly: true,
    variants: [
      { label: 'No markers', patch: { markers: [] } },
      {
        label: 'Marked',
        patch: {
          markers: [
            { x: 0.5, y: 0.258 }, // top lobe
            { x: 0.273, y: 0.695 }, // bottom-left lobe
            { x: 0.727, y: 0.695 }, // bottom-right lobe
            { x: 0.43, y: 0.5 }, // top ∩ bottom-left
            { x: 0.57, y: 0.5 }, // top ∩ bottom-right
            { x: 0.5, y: 0.625 }, // bottom-left ∩ bottom-right
            { x: 0.5, y: 0.543 }, // triple centre
          ],
        },
      },
    ],
  },
  {
    id: 'gradients',
    label: 'Gradients',
    hint: 'Export smooth colour ramps as real SVG gradients instead of flat bands.',
    blurb:
      'When on, a region whose pixels follow a smooth colour ramp is exported as one SVG linear or radial gradient instead of being cut into flat colour bands. Off forces flat fills: more shapes, each one simpler. On reproduces a smooth blend with a single gradient, so you get fewer shapes, a smaller file and a closer match to the source. Turn it off only if you want a posterised, banded look.',
    example: bundled('nebula', 'nebula.png'),
    baseOpts: { mode: 'color' },
    variants: [
      { label: 'Off', patch: { gradients: false } },
      { label: 'On', patch: { gradients: true } },
    ],
  },
  {
    id: 'mode',
    label: 'Mode',
    hint: 'Auto counts the inks: one ink gives Mono (one clean shape), more give Color.',
    blurb:
      'Whether the art is traced as colour regions or as a single-ink silhouette. Auto counts the inks the image actually uses, counting tones that are only shading of one ink as that ink. It picks Mono when there is exactly one, because a one-ink mark traced in colour gets cut in two along the line where its light side turns into its shadow side. Auto also sets the mono cut from the ink and background it measured, flips it when the ink is the lighter of the two, and paints the result in the ink’s own colour instead of black. Color and Mono force the choice; a forced Mono still gets the measured cut and the flip.',
    example: bundled('petals', 'petals.png'),
    variants: [
      { label: 'Color', patch: { mode: 'color' } },
      { label: 'Mono', patch: { mode: 'mono' } },
    ],
  },
  {
    id: 'invert',
    label: 'Invert',
    hint: 'For ink lighter than its background: flips which side of the cut becomes solid.',
    blurb:
      'Mono makes every pixel darker than the threshold solid and drops the rest, which assumes dark ink on light paper. White line art on a dark background is the other way round: every pixel of the art sits above the cut, so without Invert the trace comes back empty (or as the background traced around a hole). Invert flips which side becomes solid. In Auto mode it is set for you from the measured brightness of the ink and the background; this switch is the manual override.',
    example: synthetic('threshold'),
    baseOpts: { mode: 'mono', threshold: 128 },
    variants: [
      { label: 'Off', patch: { invert: false } },
      { label: 'On', patch: { invert: true } },
    ],
  },
  {
    id: 'centerline',
    label: 'Strokes',
    hint: 'For line art: trace each line as a stroke with a width instead of a filled outline.',
    blurb:
      'Line art (a monoline icon, a diagram, a sheet of music) is drawn with a pen of one width. A filled outline traces both edges of every pen line, so you get twice the edges and no width you can change. Strokes traces the middle of each line instead and measures how wide the ink is. The result is open and closed paths with a stroke width you can adjust, and ends and corners you can move as single points. Ink that no stroke explains (a note head, the dot of an i) still becomes a fill. In Mono, Strokes uses the same cut and Invert setting. In Colour, all the inks are traced as one drawing so crossing lines stay whole, and each stroke takes the colour it runs through.',
    example: bundled('outline', 'outline.svg'),
    baseOpts: { mode: 'mono', threshold: 128, invert: true },
    variants: [
      { label: 'Fills', patch: { centerline: false } },
      { label: 'Strokes', patch: { centerline: true } },
    ],
    liveOnly: true,
  },
  {
    id: 'threshold',
    label: 'Threshold',
    hint: 'Pixels darker than this become solid; lighter ones drop out.',
    blurb:
      'The black/white cutoff in Mono mode. Every pixel darker than the threshold becomes solid; lighter ones drop out entirely. Low keeps only the darkest core, so shapes get thin and may break up. Mid is balanced. High also picks up lighter greys, giving thicker, better-connected shapes, but it starts to catch background noise and anti-aliasing too.',
    example: synthetic('threshold'),
    baseOpts: { mode: 'mono' },
    variants: [
      { label: 'Low', patch: { threshold: 80 } },
      { label: 'Mid', patch: { threshold: 128 } },
      { label: 'High', patch: { threshold: 190 } },
    ],
  },
]

export const CONTROL_DOCS_BY_ID: Record<string, ControlDoc> = Object.fromEntries(CONTROL_DOCS.map((d) => [d.id, d]))
