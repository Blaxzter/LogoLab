// parseSvg on what real exporters write, which the walk used to get wrong: paint
// from Illustrator's internal CSS (every shape came out black), non-hex colours
// (`red`, `rgb()`, `transparent` — black to every pure renderer), hidden layers and
// group masks (drawn visible / unmasked), the style a raw leaf inherits from a
// flattened <g> (lost), and userSpaceOnUse gradient defaults (resolved as bbox
// fractions). parseSvg needs DOMParser, which node lacks, so this file carries a
// minimal XML DOM — enough of one for the walk, and nothing it doesn't call.
//
//   node --test test/svg-import.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'

// --- a minimal XML DOM --------------------------------------------------------

class Txt {
  text: string
  parentNode: El | null = null
  constructor(text: string) {
    this.text = text
  }
}

class El {
  tagName: string
  attrs: [string, string][] = []
  childNodes: (El | Txt)[] = []
  parentNode: El | null = null
  constructor(tag: string) {
    this.tagName = tag
  }
  get nodeName() {
    return this.tagName
  }
  get children(): El[] {
    return this.childNodes.filter((n): n is El => n instanceof El)
  }
  get textContent(): string {
    return this.childNodes.map((n) => (n instanceof El ? n.textContent : n.text)).join('')
  }
  getAttribute(name: string): string | null {
    return this.attrs.find(([n]) => n === name)?.[1] ?? null
  }
  getAttributeNS(): string | null {
    return null
  }
  hasAttribute(name: string): boolean {
    return this.getAttribute(name) !== null
  }
  setAttribute(name: string, value: string): void {
    const a = this.attrs.find(([n]) => n === name)
    if (a) a[1] = value
    else this.attrs.push([name, value])
  }
  removeAttribute(name: string): void {
    this.attrs = this.attrs.filter(([n]) => n !== name)
  }
  removeChild(child: El | Txt): void {
    this.childNodes = this.childNodes.filter((n) => n !== child)
    child.parentNode = null
  }
  cloneNode(): El {
    const c = new El(this.tagName)
    c.attrs = this.attrs.map(([n, v]) => [n, v])
    for (const n of this.childNodes) {
      const k = n instanceof El ? n.cloneNode() : new Txt(n.text)
      k.parentNode = c
      c.childNodes.push(k)
    }
    return c
  }
  descendants(): El[] {
    return this.children.flatMap((c) => [c, ...c.descendants()])
  }
  querySelectorAll(sel: string): El[] {
    const tags = sel.split(',').map((s) => s.trim())
    return this.descendants().filter((e) => tags.includes('*') || tags.includes(e.tagName))
  }
  querySelector(sel: string): El | null {
    return this.querySelectorAll(sel)[0] ?? null
  }
}

const decode = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')

function parseXml(src: string): El {
  const top = new El('#document')
  let cur = top
  let i = 0
  while (i < src.length) {
    if (src.startsWith('<!--', i)) i = src.indexOf('-->', i) + 3
    else if (src.startsWith('<![CDATA[', i)) {
      const end = src.indexOf(']]>', i)
      const t = new Txt(src.slice(i + 9, end))
      t.parentNode = cur
      cur.childNodes.push(t)
      i = end + 3
    } else if (src.startsWith('<?', i) || src.startsWith('<!', i)) i = src.indexOf('>', i) + 1
    else if (src.startsWith('</', i)) {
      i = src.indexOf('>', i) + 1
      cur = cur.parentNode as El
    } else if (src[i] === '<') {
      const m = /^<([^\s/>]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/.exec(src.slice(i))
      if (!m) throw new Error('bad XML at ' + i)
      const el = new El(m[1])
      for (const a of m[2].matchAll(/([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
        el.attrs.push([a[1], decode(a[2] ?? a[3])])
      }
      el.parentNode = cur
      cur.childNodes.push(el)
      if (!m[3]) cur = el
      i += m[0].length
    } else {
      const end = src.indexOf('<', i)
      const t = new Txt(decode(src.slice(i, end < 0 ? src.length : end)))
      t.parentNode = cur
      cur.childNodes.push(t)
      i = end < 0 ? src.length : end
    }
  }
  return top
}

function serialize(n: El | Txt): string {
  if (n instanceof Txt) return n.text.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  const attrs = n.attrs.map(([k, v]) => ` ${k}="${v.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`).join('')
  if (n.childNodes.length === 0) return `<${n.tagName}${attrs}/>`
  return `<${n.tagName}${attrs}>${n.childNodes.map(serialize).join('')}</${n.tagName}>`
}

Object.assign(globalThis, {
  DOMParser: class {
    parseFromString(src: string) {
      const top = parseXml(src)
      return {
        documentElement: top.children[0],
        querySelector: (s: string) => top.querySelector(s),
        querySelectorAll: (s: string) => top.querySelectorAll(s),
      }
    }
  },
  XMLSerializer: class {
    serializeToString(n: El) {
      return serialize(n)
    }
  },
})

const { parseSvg } = await import('../src/lib/path/model.ts')
const { parseCssColor } = await import('../src/lib/path/cssColor.ts')
const { parseHex } = await import('../src/lib/render/raster.ts')
type Doc = NonNullable<ReturnType<typeof parseSvg>>
type Item = Doc['items'][number]

const svg = (body: string, vb = '0 0 100 100') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}">${body}</svg>`
const parse = (body: string, vb?: string): Doc => {
  const doc = parseSvg(svg(body, vb))
  assert.ok(doc, 'parses')
  return doc
}
const paths = (doc: Doc) => doc.items.filter((i): i is Extract<Item, { kind: 'path' }> => i.kind === 'path')
const raws = (doc: Doc) => doc.items.filter((i): i is Extract<Item, { kind: 'raw' }> => i.kind === 'raw')
const SQ = 'd="M0 0H10V10H0Z"'

// --- #5 internal CSS ------------------------------------------------------------

test("Illustrator's internal CSS paints the shapes it names", () => {
  const doc = parse(
    `<defs><style>.cls-1{fill:#e30613}.cls-2{fill:rgb(0,0,255);fill-opacity:.5}</style></defs>` +
      `<path class="cls-1" ${SQ}/><rect class="cls-2" width="5" height="5"/>`,
  )
  const [a, b] = paths(doc)
  assert.equal(a.fill, '#e30613')
  assert.equal(b.fill, '#0000ff')
  assert.equal(b.fillOpacity, 0.5)
})

test('the cascade: inline style > !important aside, #id > .class > tag, later wins', () => {
  const doc = parse(
    `<style>path{fill:#111111} .a{fill:#222222} #p2{fill:#333333} .a{fill:#444444} .imp{fill:#555555 !important}</style>` +
      `<path ${SQ}/><path class="a" ${SQ}/><path id="p2" class="a" ${SQ}/>` +
      `<path class="a" style="fill:#666666" ${SQ}/><path class="imp" style="fill:#666666" ${SQ}/>` +
      `<path class="a" fill="#777777" ${SQ}/>`,
  )
  assert.deepEqual(
    paths(doc).map((p) => p.fill),
    ['#111111', '#444444', '#333333', '#666666', '#555555', '#444444'],
  )
})

test('a class-supplied gradient fill is lifted like an attribute one', () => {
  const doc = parse(
    `<defs><linearGradient id="g"><stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/></linearGradient>` +
      `<style>.st0{fill:url(#g)}</style></defs><path class="st0" ${SQ}/>`,
  )
  const [p] = paths(doc)
  assert.ok(p.gradient, 'gradient lifted')
})

test('a rule the matcher cannot resolve keeps what it may match raw, class and all', () => {
  const doc = parse(
    `<style>g .cls-1{fill:#ff0000} @media print{.cls-2{fill:#00ff00}}</style>` +
      `<g><path class="cls-1" ${SQ}/><path class="cls-2" ${SQ}/><path ${SQ}/></g>`,
  )
  // The two classed paths stay raw (with their class); the unclassed one is a path.
  assert.equal(paths(doc).length, 1)
  const r = raws(doc).filter((i) => i.markup.startsWith('<path'))
  assert.equal(r.length, 2)
  assert.match(r[0].markup, /class="cls-1"/)
})

test('markup without a stylesheet is untouched (hex kept verbatim)', () => {
  const doc = parse(`<path fill="#ABC" style="fill-opacity:0.5" ${SQ}/>`)
  const [p] = paths(doc)
  assert.equal(p.fill, '#ABC')
  assert.equal(p.fillOpacity, 0.5)
})

// --- #7 hidden content, group effects --------------------------------------------

test('a display:none layer is kept raw, never drawn as paths', () => {
  const doc = parse(`<g id="layer1" style="display:none"><path fill="#ff0000" ${SQ}/></g><path ${SQ}/>`)
  assert.equal(paths(doc).length, 1)
  assert.equal(raws(doc).length, 1)
  assert.match(raws(doc)[0].markup, /display:none/)
})

test('display:none from a class hides too', () => {
  const doc = parse(`<style>.off{display:none}</style><path class="off" fill="#ff0000" ${SQ}/>`)
  assert.equal(paths(doc).length, 0)
})

test('visibility:hidden inherits to the shape, which stays raw and hidden', () => {
  const doc = parse(`<g visibility="hidden"><path ${SQ}/><path visibility="visible" ${SQ}/></g>`)
  assert.equal(paths(doc).length, 1, 'the child that turns itself back on is a path')
  const [r] = raws(doc)
  assert.equal(r.inherited?.visibility, 'hidden')
})

test('a masked / clipped / filtered group stays raw as a whole', () => {
  for (const attr of ['mask="url(#m)"', 'clip-path="url(#c)"', 'style="filter:url(#f)"']) {
    for (const preserveGroups of [false, true]) {
      const doc = parseSvg(svg(`<g ${attr}><path ${SQ}/><path ${SQ}/></g>`), { preserveGroups })
      assert.ok(doc)
      assert.equal(doc.items.length, 1, attr)
      assert.equal(doc.items[0].kind, 'raw', attr)
    }
  }
})

// --- #9 non-hex colours ------------------------------------------------------------

test('CSS colours are reduced to hex at import, alpha into the opacity', () => {
  const doc = parse(
    `<path fill="red" ${SQ}/><path fill="rgb(37, 99, 235)" ${SQ}/><path fill="rgba(0,0,255,0.5)" ${SQ}/>` +
      `<path fill="#ff000080" ${SQ}/><path fill="hsl(120, 100%, 25%)" ${SQ}/><path fill="transparent" ${SQ}/>` +
      `<g color="#123456"><path fill="currentColor" ${SQ}/></g>` +
      `<path fill="none" stroke="rgba(255,0,0,0.5)" stroke-width="2" ${SQ}/>`,
  )
  const p = paths(doc)
  assert.deepEqual(
    p.map((x) => x.fill),
    ['#ff0000', '#2563eb', '#0000ff', '#ff0000', '#008000', '#123456', 'none'],
  )
  assert.equal(p[2].fillOpacity, 0.5)
  assert.ok(Math.abs((p[3].fillOpacity ?? 1) - 128 / 255) < 1e-9)
  assert.equal(p[6].stroke?.color, '#ff0000')
  assert.equal(p[6].stroke?.opacity, 0.5)
  // `transparent` with no stroke paints nothing: kept, but inert rather than a path.
  assert.equal(raws(doc).filter((r) => r.inert && /transparent/.test(r.markup)).length, 1)
})

test('paint that cannot be resolved stays raw instead of turning black', () => {
  const doc = parse(`<path fill="var(--brand)" ${SQ}/>`)
  assert.equal(paths(doc).length, 0)
  assert.equal(raws(doc).length, 1)
})

test('the renderers read CSS colours as well (defence in depth)', () => {
  assert.deepEqual(parseHex('red'), [255, 0, 0])
  assert.deepEqual(parseHex('rgb(37 99 235 / 50%)'), [37, 99, 235])
  assert.deepEqual(parseHex('#00ff0080'), [0, 255, 0])
  assert.deepEqual(parseHex('#abc'), [170, 187, 204])
  assert.equal(parseCssColor('currentColor'), null)
  assert.equal(parseCssColor('transparent')?.a, 0)
})

// --- #10 a raw leaf's inherited style ----------------------------------------------

test('a raw leaf keeps the stroke and font style of the <g> that was flattened away', () => {
  const doc = parse(
    `<defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient></defs>` +
      `<g stroke="#000" stroke-width="4" stroke-linecap="round" stroke-linejoin="bevel" stroke-dasharray="2 1" stroke-opacity="0.5">` +
      `<path stroke="url(#g)" ${SQ}/></g><g font-size="40" font-family="Inter"><text>Hi</text></g>`,
  )
  const [path, text] = raws(doc).filter((r) => !r.markup.startsWith('<defs'))
  assert.deepEqual(
    {
      w: path.inherited?.['stroke-width'],
      cap: path.inherited?.['stroke-linecap'],
      join: path.inherited?.['stroke-linejoin'],
      dash: path.inherited?.['stroke-dasharray'],
      op: path.inherited?.['stroke-opacity'],
    },
    { w: '4', cap: 'round', join: 'bevel', dash: '2 1', op: '0.5' },
  )
  assert.equal(text.inherited?.['font-size'], '40')
  assert.equal(text.inherited?.['font-family'], 'Inter')
})

// --- #11 gradient import ------------------------------------------------------------

const stops = '<stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/>'

test('userSpaceOnUse: a missing x2 is 100% of the viewport, a percentage a share of it', () => {
  const doc = parse(
    `<defs><linearGradient id="a" gradientUnits="userSpaceOnUse" x1="0">${stops}</linearGradient>` +
      `<linearGradient id="b" gradientUnits="userSpaceOnUse" x1="0" x2="50%">${stops}</linearGradient>` +
      `<radialGradient id="c" gradientUnits="userSpaceOnUse">${stops}</radialGradient></defs>` +
      `<path fill="url(#a)" d="M0 0H512V512H0Z"/><path fill="url(#b)" d="M0 0H512V512H0Z"/><path fill="url(#c)" d="M0 0H512V512H0Z"/>`,
    '0 0 512 512',
  )
  const [a, b, c] = paths(doc).map((p) => p.gradient)
  assert.equal(a?.type === 'linear' && a.x2, 512)
  assert.equal(b?.type === 'linear' && b.x2, 256)
  assert.ok(c?.type === 'radial')
  if (c?.type === 'radial') {
    assert.equal(c.cx, 256)
    assert.equal(c.cy, 256)
    assert.ok(Math.abs(c.r - 256) < 1e-9)
  }
})

test('objectBoundingBox gradients are unchanged', () => {
  const doc = parse(
    `<defs><linearGradient id="a" x2="50%">${stops}</linearGradient></defs><path fill="url(#a)" d="M0 0H200V100H0Z"/>`,
  )
  const [g] = paths(doc).map((p) => p.gradient)
  assert.equal(g?.type === 'linear' && g.x2, 100)
})

test('a reflect / repeat spread is not imported as pad', () => {
  const doc = parse(
    `<defs><linearGradient id="a" spreadMethod="repeat" x2="0.25">${stops}</linearGradient></defs><path fill="url(#a)" ${SQ}/>`,
  )
  assert.equal(paths(doc).length, 0)
})

test('out-of-order stop offsets are clamped in document order, not sorted', () => {
  const doc = parse(
    `<defs><linearGradient id="a"><stop offset="0.5" stop-color="#ff0000"/><stop offset="0.2" stop-color="#00ff00"/>` +
      `<stop offset="1" stop-color="red"/></linearGradient></defs><path fill="url(#a)" ${SQ}/>`,
  )
  const g = paths(doc)[0].gradient
  assert.deepEqual(
    g?.stops.map((s) => [s.offset, s.color]),
    [
      [0.5, '#ff0000'],
      [0.5, '#00ff00'],
      [1, '#ff0000'],
    ],
  )
})

test('an element a rule could not be resolved for keeps its markup un-inlined', () => {
  // Inlining `.a{fill:#000}` onto the raw path would beat the dark-mode rule in a browser.
  const doc = parse(
    `<style>.a{fill:#000000} @media (prefers-color-scheme: dark){.a{fill:#ffffff}}</style><path class="a" ${SQ}/>`,
  )
  const r = raws(doc).filter((i) => i.markup.startsWith('<path'))
  assert.equal(r.length, 1)
  assert.doesNotMatch(r[0].markup, /style=/)
})

test('a gradient whose stops a rule could not be resolved for is not lifted', () => {
  const doc = parse(
    `<defs><linearGradient id="g"><stop class="s" offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/></linearGradient></defs>` +
      `<style>@media (prefers-color-scheme: dark){.s{stop-color:#ffffff}}</style><path fill="url(#g)" ${SQ}/>`,
  )
  assert.equal(paths(doc).length, 0)
})

// --- what music engravers and icon sprites write: nested <svg>, <use>, miter limits ---

const bounds = (p: Extract<Item, { kind: 'path' }>) => {
  const xs = p.subPaths.flatMap((sp) => sp.nodes.map((n) => n.x))
  const ys = p.subPaths.flatMap((sp) => sp.nodes.map((n) => n.y))
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}

test('a nested <svg> whose content stays inside it is placed and fitted, not kept raw', () => {
  // viewBox 10 10 20 20 into a 40×40 viewport at (5, 5): scale 2, origin (10,10) → (5,5).
  const doc = parse(`<svg x="5" y="5" width="40" height="40" viewBox="10 10 20 20"><path d="M10 10H30V30H10Z"/></svg>`)
  assert.equal(raws(doc).length, 0)
  assert.deepEqual(bounds(paths(doc)[0]), [5, 5, 45, 45])
})

test('preserveAspectRatio: meet centres the viewBox, none stretches it', () => {
  const meet = parse(`<svg width="40" height="20" viewBox="0 0 10 10"><path d="M0 0H10V10H0Z"/></svg>`)
  assert.deepEqual(bounds(paths(meet)[0]), [10, 0, 30, 20])
  const none = parse(
    `<svg width="40" height="20" viewBox="0 0 10 10" preserveAspectRatio="none"><path d="M0 0H10V10H0Z"/></svg>`,
  )
  assert.deepEqual(bounds(paths(none)[0]), [0, 0, 40, 20])
})

test('a nested <svg> that would clip its content stays raw (unless overflow is visible)', () => {
  const clipped = parse(`<svg width="10" height="10"><path d="M0 0H20V20H0Z"/></svg>`)
  assert.equal(paths(clipped).length, 0)
  assert.equal(raws(clipped).length, 1)
  const visible = parse(`<svg width="10" height="10" overflow="visible"><path d="M0 0H20V20H0Z"/></svg>`)
  assert.equal(paths(visible).length, 1)
})

test('<use> of a glyph in <defs> becomes a path in place, and the dead glyph is dropped', () => {
  const doc = parse(
    `<defs><path id="g" d="M0 0H1V1H0Z"/></defs>` +
      `<use href="#g" fill="#ff0000" transform="matrix(10,0,0,-10,20,50)"/>` +
      `<use xlink:href="#g" x="5" y="5"/>`,
  )
  const [a, b] = paths(doc)
  assert.equal(a.fill, '#ff0000')
  assert.deepEqual(bounds(a), [20, 40, 30, 50])
  assert.deepEqual(bounds(b), [5, 5, 6, 6])
  // Both uses were lifted, so the defs block held nothing else and is gone.
  assert.equal(raws(doc).length, 0)
})

test('a <use> target another raw element still references is kept', () => {
  const doc = parse(`<defs><path id="g" d="M0 0H1V1H0Z"/></defs><use href="#g"/><use href="#g" filter="url(#f)"/>`)
  assert.equal(paths(doc).length, 1)
  assert.ok(raws(doc).some((r) => r.markup.includes('id="g"')))
})

test('a <use> cycle or a missing target stays raw instead of hanging', () => {
  const doc = parse(`<g id="a"><use href="#a"/></g><use href="#nope"/>`)
  assert.ok(raws(doc).length >= 2)
})

test('<use> of a <symbol> fits the symbol viewBox into the use size', () => {
  const doc = parse(
    `<symbol id="s" viewBox="0 0 10 10"><path d="M0 0H10V10H0Z"/></symbol><use href="#s" x="10" y="10" width="20" height="20"/>`,
  )
  assert.deepEqual(bounds(paths(doc)[0]), [10, 10, 30, 30])
  assert.equal(raws(doc).length, 0)
})

test('stroke-miterlimit is modelled, not a reason to keep a stroke raw', () => {
  const doc = parse(`<path fill="none" stroke="#000" stroke-width="2" stroke-miterlimit="10" d="M0 0V10"/>`)
  assert.equal(raws(doc).length, 0)
  assert.equal(paths(doc)[0].stroke?.miterLimit, 10)
  const round = parse(`<path fill="none" stroke="#000" stroke-linejoin="round" stroke-miterlimit="10" d="M0 0V10"/>`)
  assert.equal(paths(round)[0].stroke?.miterLimit, undefined, 'only a miter join reads it')
})

// --- layer names from the source ------------------------------------------------------

const { serializeDoc, docStats, humanId, ellipseSubPaths } = await import('../src/lib/path/model.ts')
const { layerRows, leafLabel, pathNoun } = await import('../src/lib/editor/layerRows.ts')
const { isInert } = await import('../src/lib/path/docTree.ts')
const { docToPdf } = await import('../src/lib/export/vectorFormats.ts')
const { normalizeDoc } = await import('../src/lib/path/normalize.ts')
const { transformItem } = await import('../src/lib/editor/transform.ts')

const parseG = (body: string, vb?: string): Doc => {
  const doc = parseSvg(svg(body, vb), { preserveGroups: true })
  assert.ok(doc, 'parses')
  return doc
}
type Group = Extract<Item, { kind: 'group' }>
const groups = (doc: Doc) => doc.items.filter((i): i is Group => i.kind === 'group')

test('a shape is named by its data-name, <title>, inkscape:label, aria-label, then a human id', () => {
  const doc = parse(
    `<path ${SQ}><title> Treble
      clef </title></path>` +
      `<path inkscape:label="Stem" aria-label="ignored" ${SQ}/>` +
      `<path data-name="Bar line" inkscape:label="ignored" ${SQ}/>` +
      `<path data-name="Renamed" ${SQ}><title>Imported</title></path>` +
      `<path aria-label="Fermata" ${SQ}/>` +
      `<path id="logo-mark" ${SQ}/>` +
      `<path id="path123" ${SQ}/>`,
  )
  assert.deepEqual(
    paths(doc).map((p) => p.name),
    ['Treble clef', 'Stem', 'Bar line', 'Renamed', 'Fermata', 'logo-mark', undefined],
  )
})

test('a path name survives export and re-import; an unnamed path writes none', () => {
  const doc = parse(`<path ${SQ}><title>Treble clef</title></path><path id="path123" ${SQ}/>`)
  const out = serializeDoc(doc)
  assert.match(out, /<path data-name="Treble clef" /)
  assert.equal(out.match(/data-name=/g)?.length, 1, 'the layers list label "Path 2" is never written')
  assert.deepEqual(
    paths(parse(out.replace(/^<svg[^>]*>|<\/svg>$/g, ''))).map((p) => p.name),
    ['Treble clef', undefined],
  )
  const quoted = parse(`<path data-name="A &amp; &quot;B&quot; &lt;C&gt;" ${SQ}/>`)
  assert.equal(paths(parse(serializeDoc(quoted).replace(/^<svg[^>]*>|<\/svg>$/g, '')))[0].name, 'A & "B" <C>')
})

test('renaming raw markup writes the name into it, so the export keeps it', async () => {
  const { renameItem } = await import('../src/components/editor/editorDoc.ts')
  const doc = parse(`<image id="photo" href="a.png" width="10" height="10"><title>Photo</title></image>`)
  const raw = raws(doc)[0]
  assert.equal(raw.name, 'Photo')
  const strip = (s: string) => s.replace(/^<svg[^>]*>|<\/svg>$/g, '')
  const renamed = renameItem(doc, raw.id, 'Hero shot')
  assert.equal(raws(parse(strip(serializeDoc(renamed))))[0].name, 'Hero shot', 'data-name beats the <title>')
  const again = renameItem(renamed, raw.id, 'Cover')
  assert.equal(raws(again)[0].markup.match(/data-name=/g)?.length, 1, 'replaced, not added twice')
  const cleared = renameItem(again, raw.id, '  ')
  assert.doesNotMatch(raws(cleared)[0].markup, /data-name/)
  assert.equal(raws(parse(strip(serializeDoc(cleared))))[0].name, 'Photo', 'back to what the source called it')
})

test('ids a tool generated are not names', () => {
  for (const id of [
    'path123',
    'g45',
    'rect7',
    'layer1',
    'Layer_1',
    'svg_3',
    'p0_font_1_63',
    'Vector_12',
    'Vector 12',
    'SVGID_2_',
    'clipPath-3',
    '_x3C_Group_x3E_',
    'MJX-1-TEX-N-31',
    'a3f9c2d1e0b4',
    ':r1:',
    '__svelte_4',
    '123',
    'c12',
  ]) {
    assert.equal(humanId(id), null, id)
  }
  for (const id of ['logo-mark', 'Isolation_Mode', 'Ebene_1', 'background', 'Wordmark 2', 'Vector', 'star']) {
    assert.equal(humanId(id), id, id)
  }
  assert.equal(humanId('Logo_x20_Mark'), 'Logo Mark', "Illustrator's escaped space")
})

test('a group is named the same way, so Inkscape layers keep their labels', () => {
  const doc = parseG(
    `<g id="layer1" inkscape:label="Layer 1"><path ${SQ}/></g><g id="g45"><path ${SQ}/></g><g data-name="Logo"><path ${SQ}/></g>`,
  )
  assert.deepEqual(
    groups(doc).map((g) => g.name),
    ['Layer 1', undefined, 'Logo'],
  )
})

test('a <use> is named by itself first, else by what it instances', () => {
  const doc = parseG(
    `<defs><path id="star" ${SQ}/><g id="pair"><path ${SQ}/><path ${SQ}/></g><path id="path9" ${SQ}/></defs>` +
      `<use href="#star"/><use href="#star" data-name="Big star"/><use href="#path9"/>` +
      `<use href="#pair" aria-label="Twins"/>`,
  )
  const named = doc.items.filter((i) => i.kind !== 'raw')
  assert.deepEqual(
    named.map((i) => i.name),
    ['star', 'Big star', undefined, 'Twins'],
  )
  assert.equal(named[3].kind, 'group', 'the instanced group is one layer')
})

test('an unnamed row says what its geometry is, and stops saying it once edited', () => {
  const doc = parse(
    `<rect width="10" height="5"/><circle cx="5" cy="5" r="4"/><ellipse cx="5" cy="5" rx="4" ry="2"/>` +
      `<line x1="0" y1="0" x2="10" y2="10" stroke="#000"/><polygon points="0,0 10,0 5,8"/>` +
      `<path d="M0 0H10V10H0ZM2 2H8V8H2Z" fill-rule="evenodd"/>` +
      `<rect width="10" height="5" transform="rotate(30)"/>`,
  )
  const p = paths(doc)
  assert.deepEqual(p.map(pathNoun), ['Rectangle', 'Circle', 'Ellipse', 'Line', 'Path', 'Compound', 'Rectangle'])
  assert.equal(leafLabel(p[0], 3), 'Rectangle 3')
  // Drag one corner: it is no longer a rectangle, and the row must not claim it is.
  const sp = p[0].subPaths[0]
  const moved = { ...p[0], subPaths: [{ ...sp, nodes: sp.nodes.map((n, i) => (i === 2 ? { ...n, x: n.x + 3 } : n)) }] }
  assert.equal(pathNoun(moved), 'Path')
  // Four smooth nodes that are not an ellipse's kappa arcs are a path.
  const blob = ellipseSubPaths(5, 5, 4, 4)!
  blob[0].nodes[0] = { ...blob[0].nodes[0], hOut: { x: 9, y: 9 } }
  assert.equal(pathNoun({ ...p[1], subPaths: blob }), 'Path')
  // Raw markup says what its element draws.
  const raw = parse(`<text>Hi</text><image href="a.png" width="4" height="4"/>`)
  assert.deepEqual(
    raws(raw).map((r) => leafLabel(r, 1)),
    ['Text 1', 'Image 1'],
  )
})

// --- shapes that paint nothing --------------------------------------------------------

/** The engraver's metadata boxes, as the user's fixture writes them. */
const SYSTEMS =
  `<g class="gb-systeme" fill="none" stroke="none" pointer-events="none">` +
  `<rect data-system="0" x="4.24" y="8.36" width="240.96" height="15.24"/>` +
  `<rect data-system="1" x="4.24" y="51.32" width="240.96" height="15.24"/></g>`

test('a shape with neither fill nor stroke is kept in place, inert: no path, no layer, no count', () => {
  for (const preserveGroups of [false, true]) {
    const doc = parseSvg(svg(`<path fill="#ff0000" ${SQ}/>${SYSTEMS}<path fill="#0000ff" ${SQ}/>`), { preserveGroups })
    assert.ok(doc)
    assert.equal(docStats(doc).paths, 2, 'the counter sees the two painted paths')
    const rows = layerRows(doc.items)
    assert.deepEqual(
      rows.map((r) => r.number),
      [2, 1],
      'only the painted paths are rows, numbered without the boxes',
    )
    // The export still has both boxes, between the two paths, with what they inherited.
    const out = serializeDoc(doc)
    assert.match(out, /#ff0000.*data-system="0".*data-system="1".*#0000ff/)
    assert.match(out, /<g fill="none" stroke="none" pointer-events="none"><rect data-system="0"/)
  }
  const doc = parseG(SYSTEMS)
  assert.equal(doc.items.length, 1)
  assert.ok(isInert(doc.items[0]), 'a group of nothing but inert boxes is no layer either')
})

test('fully transparent paint is nothing too, but a stroke or a faint fill is something', () => {
  const doc = parse(
    `<path fill="#000" fill-opacity="0" ${SQ}/><path fill="rgba(0,0,0,0)" stroke="#000" stroke-opacity="0" ${SQ}/>` +
      `<path fill="none" stroke="#000" ${SQ}/><path fill="#000" fill-opacity="0.01" ${SQ}/>`,
  )
  assert.equal(raws(doc).filter((r) => r.inert).length, 2)
  assert.equal(paths(doc).length, 2)
})

test('defs, stylesheets and stand-alone paint servers / clip paths are inert as well', () => {
  const doc = parse(
    `<defs><linearGradient id="g">${stops}</linearGradient></defs><style>.a{}</style>` +
      `<clipPath id="unused"><rect width="5" height="5"/></clipPath><text>Hi</text>`,
  )
  assert.deepEqual(
    doc.items.map((i) => (i.kind === 'raw' ? !!i.inert : null)),
    [true, true, true, false],
  )
  assert.equal(layerRows(doc.items).length, 1, 'only the text is a row')
})

// --- clip paths -----------------------------------------------------------------------

const box = (subPaths: { nodes: { x: number; y: number }[] }[]) => {
  const xs = subPaths.flatMap((sp) => sp.nodes.map((n) => n.x))
  const ys = subPaths.flatMap((sp) => sp.nodes.map((n) => n.y))
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map((v) => Math.round(v * 1e6) / 1e6)
}

/** What Illustrator writes: the clip rect in <defs>, a <clipPath> that <use>s it, and the clipped group. */
const ILLUSTRATOR =
  `<defs><rect id="SVGID_1_" x="10" y="10" width="50" height="40"/></defs>` +
  `<clipPath id="SVGID_2_"><use xlink:href="#SVGID_1_" overflow="visible"/></clipPath>` +
  `<g clip-path="url(#SVGID_2_)" transform="translate(5 0)"><path fill="#e30613" d="M0 0H100V100H0Z"/><circle cx="30" cy="30" r="5" fill="#000"/></g>`

test("Illustrator's clip group: children editable, the clip carried as absolute geometry", () => {
  const doc = parseG(ILLUSTRATOR)
  const [g] = groups(doc)
  assert.ok(g, 'a group')
  assert.equal(g.children.length, 2)
  assert.ok(g.children.every((c) => c.kind === 'path'))
  assert.equal(g.clip?.length, 1)
  // The clip lives in the group's user space, its translate included.
  assert.deepEqual(box(g.clip![0].subPaths), [15, 10, 65, 50])
  assert.equal(g.clip![0].rule, 'nonzero')
  // The clip path, and the rect only it used, are dead markup now.
  assert.equal(raws(doc).length, 0)
  assert.equal(layerRows(doc.items)[0].item.id, g.id)
})

test('the flat model has nowhere to put a clip, so there a clipped group stays raw', () => {
  const doc = parse(ILLUSTRATOR)
  assert.equal(paths(doc).length, 0)
  assert.ok(raws(doc).some((r) => r.markup.startsWith('<g') && r.markup.includes('clip-path')))
  assert.ok(
    raws(doc).some((r) => r.markup.includes('id="SVGID_1_"')),
    'what the raw group references survives',
  )
})

test('clipPathUnits=objectBoundingBox is sized from the content; clip-rule and several shapes carry over', () => {
  const doc = parseG(
    `<clipPath id="c" clipPathUnits="objectBoundingBox"><rect width="0.5" height="1"/></clipPath>` +
      `<clipPath id="d" clip-rule="evenodd"><path d="M0 0H10V10H0ZM2 2H8V8H2Z"/><circle cx="50" cy="50" r="5" clip-rule="nonzero"/></clipPath>` +
      `<g clip-path="url(#c)"><path d="M20 20H60V40H20Z"/></g>` +
      `<g clip-path="url(#d)"><path ${SQ}/></g>`,
  )
  const [bbox, multi] = groups(doc)
  assert.deepEqual(box(bbox.clip![0].subPaths), [20, 20, 40, 40])
  assert.deepEqual(
    multi.clip!.map((c) => c.rule),
    ['evenodd', 'nonzero'],
  )
})

test('a shape with a clip-path is a clip group of one; a clip the model cannot hold stays raw', () => {
  const doc = parseG(
    `<clipPath id="c"><rect width="5" height="5"/></clipPath><clipPath id="t"><text>Hi</text></clipPath>` +
      `<path clip-path="url(#c)" ${SQ}/><path clip-path="url(#t)" ${SQ}/><g mask="url(#c)"><path ${SQ}/></g>`,
  )
  const [one] = groups(doc)
  assert.equal(one.children.length, 1)
  assert.equal(one.children[0].kind, 'path')
  assert.ok(one.clip)
  assert.equal(raws(doc).filter((i) => !i.inert).length, 2, 'the text-clipped path and the masked group')
})

test('a clip round-trips through the export: <clipPath> in defs, clip-path on the <g>', () => {
  const doc = parseG(ILLUSTRATOR)
  const out = serializeDoc(doc)
  assert.match(out, /<defs><clipPath id="clip-[^"]+"><path d="M15 10L65 10L65 50L15 50Z"\/><\/clipPath><\/defs>/)
  assert.match(out, /<g clip-path="url\(#clip-[^"]+\)">/)
  const again = parseSvg(out, { preserveGroups: true })
  assert.ok(again)
  const [g] = groups(again)
  assert.deepEqual(box(g.clip![0].subPaths), [15, 10, 65, 50])
  // Ids are minted per parse; everything else is stable on a second pass.
  const unId = (t: string) => t.replace(/clip-p\d+/g, 'clip-#')
  assert.equal(unId(serializeDoc(again)), unId(out))
})

test('the PDF clips with W n; a multi-loop union is oriented into one nonzero path', () => {
  const doc = parseG(ILLUSTRATOR)
  const pdf = new TextDecoder('latin1').decode(docToPdf(doc))
  assert.match(pdf, /q\n15 10 m\n65 10 l\n65 50 l\n15 50 l\n15 10 l\nh\nW n\n0.89 0.024 0.075 rg/)
  // Two squares wound opposite ways: the union must not cancel where they overlap.
  const two = parseG(
    `<clipPath id="c"><path d="M0 0H10V10H0Z"/><path d="M5 5V15H15V5Z"/></clipPath><g clip-path="url(#c)"><path d="M0 0H20V20H0Z"/></g>`,
  )
  const pdf2 = new TextDecoder('latin1').decode(docToPdf(two))
  assert.equal((pdf2.match(/W n/g) ?? []).length, 1)
  assert.match(pdf2, /15 5 m\n15 15 l\n5 15 l\n5 5 l/, 'the second loop reversed to wind like the first')
})

test('normalize moves a clip with its group', () => {
  const n = normalizeDoc(parseG(ILLUSTRATOR), { size: 24, inset: 2 })
  const [g] = groups(n)
  const child = g.children[0] as Extract<Item, { kind: 'path' }>
  // The clip keeps its place relative to the content it clips.
  const c = box(g.clip![0].subPaths)
  const p = box(child.subPaths)
  const k = (p[2] - p[0]) / 100
  assert.ok(Math.abs(c[0] - (p[0] + 10 * k)) < 1e-6)
  assert.ok(Math.abs(c[3] - (p[1] + 50 * k)) < 1e-6)
})

test('moving a clipped group in the editor moves its clip', () => {
  const [g] = groups(parseG(ILLUSTRATOR))
  const moved = transformItem(g, [1, 0, 0, 1, 10, 0]) as Group
  assert.deepEqual(box(moved.clip![0].subPaths), [25, 10, 75, 50])
})

// --- clip groups in the editor -----------------------------------------------------

const { pickItem } = await import('../src/lib/editor/hitTest.ts')
const { selectionBox, transformItems, translation } = await import('../src/lib/editor/transform.ts')
const { pdfClip, signedArea } = await import('../src/lib/export/vectorFormats.ts')
const { ungroupSelected, releaseClips } = await import('../src/components/editor/selectionOps.ts')

test('transforming a clipped group by id moves the clip with the content', () => {
  const doc = parseG(ILLUSTRATOR)
  const [g] = groups(doc)
  const [moved] = transformItems(doc.items, new Set([g.id]), translation(30, 0)) as Group[]
  assert.deepEqual(box(moved.clip![0].subPaths), [45, 10, 95, 50])
})

test('a click where the clip hides the content goes to the shape behind it', () => {
  const doc = parseG(
    `<rect x="70" y="70" width="20" height="20" fill="#f00"/><clipPath id="c"><rect width="50" height="50"/></clipPath>` +
      `<g clip-path="url(#c)"><path fill="#00f" d="M0 0H100V100H0Z"/></g>`,
  )
  const [red] = paths(doc)
  const [g] = groups(doc)
  assert.equal(pickItem(doc.items, { x: 80, y: 80 }, 0.5)?.id, red.id)
  assert.equal(pickItem(doc.items, { x: 20, y: 20 }, 0.5)?.id, g.id)
})

test("a clipped group's box is what the clip lets through", () => {
  const doc = parseG(
    `<clipPath id="c"><rect width="50" height="50"/></clipPath><g clip-path="url(#c)"><path d="M0 0H1000V1000H0Z"/></g>`,
  )
  const [g] = groups(doc)
  assert.deepEqual(selectionBox(doc.items, new Set([g.id])), { x: 0, y: 0, w: 50, h: 50 })
})

test('Ungroup leaves a clip group whole; Release clip drops the clip and keeps the group', () => {
  const doc = parseG(ILLUSTRATOR)
  const [g] = groups(doc)
  assert.equal(ungroupSelected(doc, new Set([g.id])), null)
  const released = releaseClips(doc, new Set([g.id]))
  assert.ok(released)
  const [after] = groups(released)
  assert.equal(after.clip, undefined)
  assert.equal(after.children.length, 2)
  assert.ok(ungroupSelected(released, new Set([after.id])), 'now it ungroups')
})

test('the PDF clip orients a two-anchor leaf by its curves, so an overlap is not cut out', () => {
  const doc = parseG(
    `<clipPath id="c"><path d="M100 50 C100 -16 0 -16 0 50 C0 116 100 116 100 50Z"/><path d="M20 20H80V80H20Z"/></clipPath>` +
      `<g clip-path="url(#c)"><path d="M0 0H100V100H0Z"/></g>`,
  )
  const [g] = groups(doc)
  const one = pdfClip(g.clip!)
  assert.ok(one)
  const signs = one.subPaths.map((sp) => Math.sign(signedArea(sp)))
  assert.equal(signs[0], signs[1], `windings ${signs}`)
  assert.ok(Math.abs(signedArea(one.subPaths[0])) > 7000, 'the leaf has its true area, not its anchors’ 0')
})

test('a non-painting <use> target written twice does not repeat its id', () => {
  const out = serializeDoc(
    parseSvg(
      svg(
        `<defs><rect id="hit" width="10" height="10" fill="none"/></defs><use href="#hit"/><use href="#hit" x="20"/>`,
      ),
    )!,
  )
  assert.ok((out.match(/id="hit"/g) ?? []).length <= 1, out)
})
