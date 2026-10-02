// One HTML page per studio route, and the sitemap that lists them.
//
// The app is an SPA: every route used to be served the same index.html, with the
// home page's title, description and a canonical pointing at `/`. To a crawler
// that is one page — list /vectorize in a sitemap and Google files it as a
// duplicate of the home page ("Alternate page with proper canonical tag"), and
// most AI crawlers don't run JavaScript, so the head and the static copy in
// #root are ALL they learn about a route.
//
// So the build writes `<route>.html` next to index.html, each with its own head
// and copy. Cloudflare Workers Assets serves `/vectorize` from `vectorize.html`
// without a redirect, and the page boots the same app (same scripts, absolute
// asset URLs), so nothing changes for a person. The sitemap comes from the same
// table, so a route cannot be listed without having a page of its own.
//
// The copy describes what the app does; keep it true when a feature moves.

import type { Plugin } from 'vite'

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
]

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

export const fileFor = (page: RoutePage) => (page.path === '/' ? 'index.html' : `${page.path.slice(1)}.html`)
const urlFor = (page: RoutePage) => ORIGIN + page.path
/** The link-preview card: the home page keeps og.png, a route has its own (scripts/og/card.html). */
export const ogImageFor = (page: RoutePage) => `${ORIGIN}/${page.path === '/' ? 'og.png' : `og${page.path}.png`}`

function copyFor(page: RoutePage, pages: RoutePage[]): string {
  const links = pages
    .filter((p) => p.path !== page.path)
    .map((p) => `<a href="${p.path}">${esc(p.nav)}</a>`)
    .join(' · ')
  return [
    `<main style="max-width: 40rem; margin: 4rem auto; padding: 0 1rem; font: 14px/1.6 system-ui, sans-serif; opacity: 0.75">`,
    `<h1>${esc(page.h1)}</h1>`,
    `<p>${page.intro}</p>`,
    `<ul>${page.points.map((p) => `<li>${p}</li>`).join('')}</ul>`,
    `<p>Free and open source (MIT): <a href="https://github.com/Blaxzter/LogoLab">github.com/Blaxzter/LogoLab</a>. The same vectorizer runs from coding agents as an MCP server: <code>npx -y logolab</code>.</p>`,
    `<nav>${links}</nav>`,
    `</main>`,
  ].join('\n')
}

/**
 * The built index.html with `page`'s head and copy. Each substitution must
 * land: a head tag renamed in index.html would otherwise ship every page with
 * the home page's canonical, which is the exact duplicate this exists to avoid.
 */
export function renderRoutePage(shell: string, page: RoutePage, pages: RoutePage[] = ROUTE_PAGES): string {
  const swaps: [RegExp, string][] = [
    [/<title>[^<]*<\/title>/, `<title>${esc(page.title)}</title>`],
    [/(<meta\s+name="description"\s+content=")[^"]*(")/, `$1${esc(page.description)}$2`],
    [/(<meta\s+property="og:url"\s+content=")[^"]*(")/, `$1${urlFor(page)}$2`],
    [/(<meta\s+property="og:title"\s+content=")[^"]*(")/, `$1${esc(page.title)}$2`],
    [/(<meta\s+property="og:description"\s+content=")[^"]*(")/, `$1${esc(page.description)}$2`],
    [/(<meta\s+name="twitter:title"\s+content=")[^"]*(")/, `$1${esc(page.title)}$2`],
    [/(<meta\s+name="twitter:description"\s+content=")[^"]*(")/, `$1${esc(page.description)}$2`],
    [/(<meta\s+property="og:image"\s+content=")[^"]*(")/, `$1${ogImageFor(page)}$2`],
    [/(<meta\s+name="twitter:image"\s+content=")[^"]*(")/, `$1${ogImageFor(page)}$2`],
    [/(<link\s+rel="canonical"\s+href=")[^"]*(")/, `$1${urlFor(page)}$2`],
    [/<main[\s\S]*?<\/main>/, copyFor(page, pages)],
  ]
  let html = shell
  for (const [pattern, replacement] of swaps) {
    if (!pattern.test(html)) throw new Error(`route pages: index.html has no match for ${pattern}`)
    html = html.replace(pattern, replacement)
  }
  return html
}

export function sitemapXml(pages: RoutePage[] = ROUTE_PAGES): string {
  const urls = pages.map((p) => `  <url>\n    <loc>${urlFor(p)}</loc>\n  </url>`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`
}

export function routePages(): Plugin {
  return {
    name: 'logolab:route-pages',
    apply: 'build',
    // After Vite's own HTML plugin, so the shell already carries the hashed
    // script and style tags every page needs to boot the app.
    enforce: 'post',
    generateBundle(_options, bundle) {
      const shell = bundle['index.html']
      if (shell?.type !== 'asset') return this.error('route pages: no index.html in the bundle')
      const source = String(shell.source)
      for (const page of ROUTE_PAGES) {
        const html = renderRoutePage(source, page)
        if (page.path === '/') shell.source = html
        else this.emitFile({ type: 'asset', fileName: fileFor(page), source: html })
      }
      this.emitFile({ type: 'asset', fileName: 'sitemap.xml', source: sitemapXml() })
    },
  }
}
