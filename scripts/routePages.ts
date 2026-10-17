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
// The table itself lives in src/lib/seo/routeCopy.ts, because the app renders it too.

import { execFileSync } from 'node:child_process'
import type { Plugin } from 'vite'
import { ORIGIN, ROUTE_PAGES, type RoutePage } from '../src/lib/seo/routeCopy.ts'

export { ORIGIN, ROUTE_PAGES, type RoutePage } from '../src/lib/seo/routeCopy.ts'

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
    // Padding, not a top margin: a margin collapses through <body>, which then
    // moves when the app replaces this copy — a layout shift of the whole page.
    `<main style="max-width: 40rem; margin: 0 auto; padding: 4rem 1rem 0; font: 14px/1.6 system-ui, sans-serif; opacity: 0.75">`,
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

/**
 * `lastmod` is the day this file last changed in git: the copy in this table is
 * what a crawler reads on every page, so it is the date the pages changed. Not
 * the build date — Google ignores a lastmod that moves on every deploy. Null
 * (no lastmod) when git can't say, e.g. a shallow clone that doesn't reach it.
 */
export function pagesLastModified(): string | null {
  try {
    const day = execFileSync('git', ['log', '-1', '--format=%cs', '--', 'scripts/routePages.ts'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null
  } catch {
    return null
  }
}

export function sitemapXml(pages: RoutePage[] = ROUTE_PAGES, lastmod: string | null = null): string {
  const mod = lastmod ? `\n    <lastmod>${lastmod}</lastmod>` : ''
  const urls = pages.map((p) => `  <url>\n    <loc>${urlFor(p)}</loc>${mod}\n  </url>`).join('\n')
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
      this.emitFile({ type: 'asset', fileName: 'sitemap.xml', source: sitemapXml(ROUTE_PAGES, pagesLastModified()) })
    },
  }
}
