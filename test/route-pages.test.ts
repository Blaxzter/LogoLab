// Every studio route is its own page to a crawler (scripts/routePages.ts).
//
//   node --test test/route-pages.test.ts
//
// What this guards is invisible in the app: a person gets the same SPA on every
// route either way. A route page that kept the home page's canonical would be
// filed by Google as a duplicate of `/` and dropped; a sitemap entry with no page
// of its own is the same mistake from the other end; and a card that is missing
// from public/og/ previews as a broken image on every share of that link.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ORIGIN, ROUTE_PAGES, fileFor, ogImageFor, renderRoutePage, sitemapXml } from '../scripts/routePages.ts'

const root = (p: string) => fileURLToPath(new URL(`../${p}`, import.meta.url))
const shell = readFileSync(root('index.html'), 'utf8')

const tag = (html: string, pattern: RegExp) => html.match(pattern)?.[1]

test('each route page has its own head, pointing at itself', () => {
  const seen = { title: new Set<string>(), description: new Set<string>() }
  for (const page of ROUTE_PAGES) {
    const html = renderRoutePage(shell, page)
    const url = ORIGIN + page.path
    assert.equal(tag(html, /<link\s+rel="canonical"\s+href="([^"]*)"/), url, `${page.path}: canonical`)
    assert.equal(tag(html, /<meta\s+property="og:url"\s+content="([^"]*)"/), url, `${page.path}: og:url`)
    assert.equal(tag(html, /<meta\s+property="og:image"\s+content="([^"]*)"/), ogImageFor(page))
    assert.equal(tag(html, /<meta\s+name="twitter:image"\s+content="([^"]*)"/), ogImageFor(page))
    seen.title.add(tag(html, /<title>([^<]*)<\/title>/) ?? '')
    seen.description.add(tag(html, /<meta\s+name="description"\s+content="([^"]*)"/) ?? '')
    // The copy a crawler reads, and the links that let it find the other pages.
    assert.ok(html.includes(`<h1>`), `${page.path}: no static copy in #root`)
    for (const other of ROUTE_PAGES.filter((p) => p !== page)) {
      assert.ok(html.includes(`href="${other.path}"`), `${page.path} does not link to ${other.path}`)
    }
  }
  assert.equal(seen.title.size, ROUTE_PAGES.length, 'two routes share a title')
  assert.equal(seen.description.size, ROUTE_PAGES.length, 'two routes share a description')
})

test('the page still boots the app', () => {
  // A route page is the shell with a different head, not a different document.
  const html = renderRoutePage(shell, ROUTE_PAGES.find((p) => p.path === '/vectorize')!)
  assert.ok(html.includes('<div id="root">'))
  assert.ok(html.includes('src="/src/main.tsx"'), 'the app entry script is gone')
})

test('the sitemap lists exactly the pages that exist', () => {
  const locs = [...sitemapXml().matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1])
  assert.deepEqual(
    locs,
    ROUTE_PAGES.map((p) => ORIGIN + p.path),
  )
  assert.equal(new Set(ROUTE_PAGES.map(fileFor)).size, ROUTE_PAGES.length)
})

test('every link-preview card exists', () => {
  for (const page of ROUTE_PAGES) {
    const file = ogImageFor(page).slice(ORIGIN.length + 1)
    assert.ok(existsSync(root(`public/${file}`)), `public/${file} is missing`)
  }
})

test('a renamed head tag fails the build instead of shipping the home canonical', () => {
  const broken = shell.replace('rel="canonical"', 'rel="canonical-renamed"')
  assert.throws(() => renderRoutePage(broken, ROUTE_PAGES[1]), /canonical/)
})
