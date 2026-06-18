// Single source of truth for the vectorize control documentation: each tuning
// knob's short hint, long explanation, the bundled example that best shows it
// off, and the before/after variant spread to render in its info dialog.
//
// Deliberately framework-free (only a type-only import) so BOTH the Node
// build-time preview generator (src/devtest/genControlPreviews.ts) and the
// in-browser ControlInfoDialog import the exact same descriptors — the labels,
// example choice and option values can never drift between them.

import type { VectorizeOptions } from '../../types'

/** A bundled example the headless generator can rebuild without a browser. */
export type ExampleKey = 'bloom' | 'nebula' | 'petals'

/** A synthesized demo scene (see src/devtest/previewScenes.ts). */
export type SceneName = 'smoothing' | 'despeckle' | 'fidelity' | 'threshold' | 'overlaps'

/**
 * Where a control's preview imagery comes from: a bundled logo (shown as-is and
 * loaded by the generator) or a purpose-built synthetic scene (rasterized by the
 * generator, which also emits an SVG thumbnail of the source).
 */
export type ExampleSource =
  | { kind: 'bundled'; key: ExampleKey; file: string }
  | { kind: 'synthetic'; scene: SceneName }

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
   * Potrace can't run headlessly (WASM + DOMParser), so the Engine dialog has
   * no precomputed grid — it compares live in the browser instead.
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
    hint: 'Curve fitting — higher melts detail into smooth curves.',
    blurb:
      'How hard the tracer fits curves to the pixel edges. None hugs every pixel — lots of nodes, jagged edges kept faithfully. Medium balances clean curves against fidelity. High melts small wiggles into long, sweeping Béziers: the fewest nodes, but fine detail and subtle inflections soften. On the default Crisp engine this is gentle (a sub-pixel pre-blur); switch the Engine to Potrace for dramatic smoothing.',
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
    hint: 'Suppresses anti-aliasing slivers and speckles.',
    blurb:
      'Removes tiny stray regions before tracing. None keeps every speck, including the anti-aliasing slivers along edges — faithful but messy and node-heavy. Medium drops stray dots and fringe. High aggressively merges small areas and near-identical colours: the cleanest output, but it can swallow intentional small details like dots, thin outlines or punctuation.',
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
    hint: 'Snap near-circles, lines and shared centers to perfect geometry.',
    blurb:
      'After tracing, near-circles, near-lines and shared centres are snapped to perfect shapes — but only if the snap moves the outline less than this many pixels. Off keeps the raw traced outline exactly. Default (1.5px) straightens the obvious circles and lines. High (6px) allows more drift for very regular geometry — great for clean icons, risky for organic artwork where it can over-regularise.',
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
      'How finely the image is split into shapes before tracing. Auto merges similar colours into a few macro-regions — best for smooth gradients. Medium and High keep subtler regions, like the soft blend where translucent shapes overlap, as their own shapes. Higher recovers those overlaps but can fragment a smooth gradient into flat bands, and is slower. Placing Mark seeds is the surgical alternative to cranking this up everywhere.',
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
    hint: 'Pin a spot to keep it as its own shape.',
    blurb:
      'Region markers are seeds for the segmentation: a marker means “keep a distinct shape here.” Two regions that contain different markers never merge, and a marked region is never absorbed by a neighbour — so they’re the surgical way to recover something the automatic merge would otherwise swallow, most often the soft blend where translucent shapes overlap. Turn on Place markers, then click the image (either pane) to drop a seed; click a seed to remove it. To split an overlap from the shapes around it, mark BOTH the overlap and its neighbours. Unmarked areas merge exactly as before.',
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
    hint: 'Export smooth color ramps as real SVG gradients, not flat bands.',
    blurb:
      'When on, a region whose pixels follow a smooth colour ramp is exported as one real SVG linear/radial gradient instead of being chopped into flat colour bands. Off forces flat fills — more shapes, simpler each. On reproduces smooth blends with a single gradient: fewer shapes, a smaller file and a truer match to the source. Turn it off only when you specifically want a posterised, banded look.',
    example: bundled('nebula', 'nebula.png'),
    baseOpts: { mode: 'color' },
    variants: [
      { label: 'Off', patch: { gradients: false } },
      { label: 'On', patch: { gradients: true } },
    ],
  },
  {
    id: 'threshold',
    label: 'Threshold',
    hint: 'Pixels darker than this become solid; lighter ones drop out.',
    blurb:
      'The black/white cutoff in Mono mode. Every pixel darker than the threshold becomes solid; lighter ones drop out entirely. Low keeps only the darkest core (thin, may break up). Mid is balanced. High captures lighter greys too — thicker, more connected shapes, but it also starts picking up background noise and anti-aliasing.',
    example: synthetic('threshold'),
    baseOpts: { mode: 'mono' },
    variants: [
      { label: 'Low', patch: { threshold: 80 } },
      { label: 'Mid', patch: { threshold: 128 } },
      { label: 'High', patch: { threshold: 190 } },
    ],
  },
  {
    id: 'engine',
    label: 'Engine',
    hint: 'Planar = clean shared edges, no overlap. Crisp = fewest nodes. Potrace = closest to the pixels.',
    blurb:
      'How the outline is drawn. Planar traces the colour regions as one shared boundary curve between each pair of neighbours, so the shapes tile with no overlap and no hairline colour bleed — the cleanest, most editable result. Crisp uses sub-pixel marching-squares plus Schneider Bézier fitting per region (overlapping stacked shapes): the fewest nodes, great for line-art. Potrace is Peter Selinger’s classic bilevel tracer — closest to the pixels, more nodes. Potrace runs only in the browser, so load a logo and compare on your own artwork.',
    example: bundled('petals', 'petals.png'),
    liveOnly: true,
    variants: [
      { label: 'Planar', patch: { engine: 'planar' } },
      { label: 'Crisp', patch: { engine: 'crisp' } },
      { label: 'Potrace', patch: { engine: 'potrace' } },
    ],
  },
]

export const CONTROL_DOCS_BY_ID: Record<string, ControlDoc> = Object.fromEntries(
  CONTROL_DOCS.map((d) => [d.id, d]),
)
