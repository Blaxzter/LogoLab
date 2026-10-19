// The words every route page says about itself: title, description and the
// copy. One table, read twice — by the build (scripts/routePages.ts writes each
// route's HTML and the sitemap from it) and by the app (RouteAbout renders the
// same copy under the panel). Most crawlers that run JavaScript index the page
// AFTER the app has replaced the static copy, so the app has to say it too.
//
// The copy describes what the app does; keep it true when a feature moves.
// `intro` and `points` may use <strong> and nothing else: the build inlines
// them as HTML, the app parses that one tag.

export const ORIGIN = 'https://logolab.fabraham.dev'

export interface RoutePage {
  /** `/` or `/vectorize`; the output file is `index.html` or `vectorize.html`. */
  path: string
  /** Short name for the cross-links between pages. */
  nav: string
  title: string
  description: string
  h1: string
  /** Paragraphs and list items of the static copy, as trusted HTML. */
  intro: string
  points: string[]
}

export const ROUTE_PAGES: RoutePage[] = [
  {
    path: '/',
    nav: 'Home',
    title: 'LogoLab — free image to SVG vectorizer, logo preview & icon export',
    description:
      'Free online vectorizer: turn a PNG or JPG logo into a clean SVG in your browser — no upload, no sign-up, no watermark. Preview it in real contexts, remove the background, and export favicons and PWA icons.',
    h1: 'LogoLab — free online image to SVG vectorizer',
    intro:
      'Convert a PNG, JPG or WebP logo or icon into a clean, editable SVG, right in your browser. No upload, no sign-up, no watermark, free and open source (MIT).',
    points: [
      '<strong>Vectorize:</strong> real tracing (region segmentation and curve fitting), not an image embedded in an SVG. Flat colour, one-ink and gradient art; line art comes back as strokes.',
      '<strong>Clean up:</strong> remove a baked-in background with a flood fill, brushes or an in-browser AI cutout.',
      '<strong>Edit:</strong> a built-in SVG editor with node editing, booleans and live text.',
      '<strong>Preview:</strong> see the logo on devices, websites, browser tabs, app stores and avatars, from 16px up.',
      '<strong>Export:</strong> favicons, apple-touch, PWA and Android icon sets; split an AI-generated icon sheet into separate icons.',
    ],
  },
  {
    path: '/vectorize',
    nav: 'PNG to SVG',
    title: 'Free PNG to SVG converter — vectorize a logo online | LogoLab',
    description:
      'Convert PNG, JPG or WebP to a clean SVG in your browser. Real tracing with sharp corners and shared edges, colour, one-ink and gradient modes, line art as strokes. No upload, no watermark, free.',
    h1: 'Convert PNG or JPG to SVG — free, in your browser',
    intro:
      'Drop in a logo or icon and get an editable vector back. The image never leaves your device: the tracer runs locally in a Web Worker.',
    points: [
      'Real vectorization: region segmentation and curve fitting, so the SVG scales and stays small. Not a bitmap wrapped in an SVG.',
      'Neighbouring colours share one edge, so there are no hairline gaps between shapes.',
      'Flat colour, one-ink (mono) and gradient modes, picked for you from the image.',
      'Line art and icons can come back as stroked centrelines instead of outlines.',
      '“Find best settings” traces several candidates and keeps the one closest to your image.',
      'A difference view shows exactly where the trace departs from the original, with a ΔE score.',
    ],
  },
  {
    path: '/cleanup',
    nav: 'Remove background',
    title: 'Remove a logo background online — free, no upload | LogoLab',
    description:
      'Remove the background from a logo or AI-generated icon in your browser: one-click AI cutout, magic wand, key out a colour, erase and restore brushes. Nothing is uploaded.',
    h1: 'Remove the background from a logo — free, in your browser',
    intro:
      'For AI-generated icons and logos that come with a baked-in background. Everything runs on your device, including the AI model.',
    points: [
      'Auto-remove floods the background from the corners in one click.',
      'AI auto-remove runs a segmentation model (RMBG-1.4) in the browser for hard backgrounds and enclosed holes.',
      'Magic wand, remove-by-colour, and erase / restore brushes for the leftovers.',
      'Tolerance, edge softness and defringe for clean anti-aliased edges; full undo and redo.',
    ],
  },
  {
    path: '/editor',
    nav: 'SVG editor',
    title: 'Free online SVG editor — nodes, booleans, live text | LogoLab',
    description:
      'Edit an SVG logo in your browser: move nodes, combine shapes with boolean operations, set fills, strokes and gradients, and add live text with real fonts. Free, no account.',
    h1: 'A free SVG editor for logos and icons',
    intro: 'Open a traced logo or any SVG and fix it by hand, without installing anything.',
    points: [
      'Node editing: drag anchors and handles, double-click a shape to edit its path.',
      'Boolean operations: unite, subtract, intersect and exclude shapes.',
      'Live text set with HarfBuzz (kerning, ligatures, variable fonts), convertible to curves.',
      'Fills, strokes, gradients, caps and joins; export the result as SVG.',
    ],
  },
  {
    path: '/sheet',
    nav: 'Split icon sheet',
    title: 'Split an icon sheet into separate SVG icons — free | LogoLab',
    description:
      'Turn one AI-generated sheet of icons into separate, traced SVG icons. Finds each icon, reads its caption to name it, and vectorizes them all in your browser.',
    h1: 'Split an icon sheet into separate SVG icons',
    intro:
      'Image models often draw a whole set of icons on one canvas. LogoLab cuts the sheet apart and traces every icon.',
    points: [
      'Finds each icon on the sheet automatically, with its caption read by OCR to name the file.',
      'Every tile is vectorized and can be fine-tuned on its own.',
      'Download the whole set at once. Nothing is uploaded.',
    ],
  },
  {
    path: '/export',
    nav: 'Favicon & PWA icons',
    title: 'Favicon & PWA icon generator from your logo — free | LogoLab',
    description:
      'Generate favicon.ico, apple-touch-icon, maskable PWA icons, Android icons and a web manifest from one logo, in your browser. Free, no upload.',
    h1: 'Generate favicons and PWA icons from your logo',
    intro: 'One logo in, every icon file a website or installable web app needs out.',
    points: [
      'favicon.ico, 16–48px favicon PNGs and apple-touch-icon.',
      'PWA manifest icons, including maskable icons with a safe zone.',
      'Android launcher icons.',
      'Built from the vector, so small sizes stay crisp.',
    ],
  },
  {
    path: '/preview',
    nav: 'Logo preview',
    title: 'Preview your logo on devices, websites and app icons | LogoLab',
    description:
      'See your logo in real contexts before you ship it: phone home screens, a website header, browser tabs, an App Store listing, avatars, and a 16–128px legibility check on light and dark.',
    h1: 'Preview your logo in real contexts',
    intro: 'Is it legible at 16px? Does it vanish on a white nav bar? Check before you ship it.',
    points: [
      'Your logo composited into real device screenshots, a website nav, browser tabs and an app store listing.',
      'A size and contrast matrix from 16 to 128px on light and dark backgrounds.',
      'Background card and recolour tools for marks that disappear on white.',
    ],
  },
  {
    path: '/labs/bench',
    nav: 'Vectorizer benchmark',
    title: 'Why pixel scores can’t judge an SVG: a vectorizer benchmark | LogoLab',
    description:
      'LogoLab, VTracer, Potrace and StarVector on 100 held-out SVG-Bench emoji, scored against the authored SVG. Colour error, edge error, nodes and kinks sit next to DINO, LPIPS and SSIM, with the cases where each metric gets it wrong.',
    h1: 'Pixel scores can’t see the SVG',
    intro:
      'The published image-to-SVG benchmarks render each SVG back to pixels and compare pictures. On flat icons that comparison saturates, so traces with three times the nodes and visibly kinked curves get the same score. This benchmark also scores the drawing, against the vector art that produced the image.',
    points: [
      'DINO scores two traces of the same emoji 0.9999 and 0.9998, though one has 68 nodes and the other 235.',
      'On some cases LPIPS and DINO prefer a trace whose outline is three times further from the drawing.',
      'A black silhouette of a brown leg scores 0.967, because a recognition network still sees a leg.',
      'LogoLab loses on the cases where its ink detection merges two tones, and the page shows them next to the tool that gets them right.',
      'The dataset and tools are pinned, every output is scored, and the harness is open source.',
    ],
  },
]
