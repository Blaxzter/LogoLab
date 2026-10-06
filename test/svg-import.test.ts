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
    ['#ff0000', '#2563eb', '#0000ff', '#ff0000', '#008000', 'none', '#123456', 'none'],
  )
  assert.equal(p[2].fillOpacity, 0.5)
  assert.ok(Math.abs((p[3].fillOpacity ?? 1) - 128 / 255) < 1e-9)
  assert.equal(p[7].stroke?.color, '#ff0000')
  assert.equal(p[7].stroke?.opacity, 0.5)
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
