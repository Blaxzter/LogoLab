// Copy / Cut / Paste in the SVG editor: what the clipboard holds, and where a paste lands.
//
//   node --test test/editor-clipboard.test.ts
//
// The failures here are quiet ones. A paste that reuses an id selects (and later
// edits) the original too; a pasted SVG whose `id="a"` matches one already in
// the drawing paints with the OTHER drawing's gradient; a live text copied as
// markup comes back as outlines. So the tests check ids, references and
// geometry rather than that "something was pasted".
//
// parseSvg needs DOMParser, which node lacks; this carries the same minimal XML
// DOM as svg-import.test.ts.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { DocItem, EditableDoc, GroupItem, PathItem, RawItem, SubPath } from '../src/lib/path/types.ts'

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

const { walkItems, findItem, removeItems } = await import('../src/lib/path/docTree.ts')
const { selectionBox, itemBox } = await import('../src/lib/editor/transform.ts')
const {
  clipMarkup,
  copySelection,
  insertPasted,
  nextPaste,
  pasteClip,
  pasteStep,
  placeForeign,
  readForeignSvg,
  renameRawIds,
  takenIds,
} = await import('../src/components/editor/clipboard.ts')

const square = (x: number, y: number, s: number): SubPath[] => [
  {
    closed: true,
    nodes: [
      [x, y],
      [x + s, y],
      [x + s, y + s],
      [x, y + s],
    ].map(([px, py]) => ({ x: px, y: py, hIn: null, hOut: null, kind: 'corner' as const })),
  },
]
const path = (id: string, x: number, y: number, s: number, extra: Partial<PathItem> = {}): PathItem => ({
  kind: 'path',
  id,
  fill: '#ff0000',
  fillRule: 'nonzero',
  subPaths: square(x, y, s),
  visible: true,
  ...extra,
})
const raw = (id: string, markup: string, extra: Partial<RawItem> = {}): RawItem => ({
  kind: 'raw',
  id,
  markup,
  visible: true,
  ...extra,
})
const textGroup = (id: string): GroupItem => ({
  kind: 'group',
  id,
  visible: true,
  children: [path(`${id}~0`, 10, 10, 5)],
  text: {
    runs: [{ text: 'Hi' }],
    style: { font: 'inter', size: 12, weight: 400, italic: false, fill: '#000000', tracking: 0 },
    align: 'left',
    lineHeight: 1.2,
    kerning: true,
    matrix: [1, 0, 0, 1, 10, 20],
  },
})
const doc = (items: DocItem[], viewBox: EditableDoc['viewBox'] = [0, 0, 100, 100]): EditableDoc => ({ viewBox, items })
const allIds = (items: readonly DocItem[]) => {
  const ids: string[] = []
  walkItems(items, (it) => ids.push(it.id))
  return ids
}
const viewBoxOf = (svg: string) => /viewBox="([^"]+)"/.exec(svg)?.[1].split(' ').map(Number)

/* ---------------------------------------------------------------- copy */

test('the markup is framed on the selection, widened by half the widest stroke', () => {
  const d = doc([
    path('a', 10, 10, 20),
    path('b', 50, 40, 10, { stroke: { color: '#000000', width: 4, cap: 'butt', join: 'miter' } }),
    path('c', 80, 80, 5),
  ])
  const clip = copySelection(d, new Set(['a', 'b']))
  assert.ok(clip)
  assert.deepEqual(viewBoxOf(clip.svg), [8, 8, 54, 44])
  assert.ok(clip.svg.startsWith('<svg'), 'standalone SVG')
  assert.equal((clip.svg.match(/<path/g) ?? []).length, 2, 'only the selection')
})

test('the clip holds deep copies in PAINT order, whatever order they were selected in', () => {
  const d = doc([path('a', 0, 0, 10), path('b', 20, 0, 10)])
  const clip = copySelection(d, new Set(['b', 'a']))
  assert.ok(clip)
  assert.deepEqual(
    clip.items.map((i) => i.id),
    ['a', 'b'],
  )
  assert.deepEqual(clip.sourceIds, ['a', 'b'])
  // A later edit to the drawing must not reach into the clip.
  ;(d.items[0] as PathItem).subPaths[0].nodes[0].x = 999
  assert.equal((clip.items[0] as PathItem).subPaths[0].nodes[0].x, 0)
})

test('a selected child of a selected group is copied once, inside its group', () => {
  const g: GroupItem = { kind: 'group', id: 'g', visible: true, children: [path('a', 0, 0, 10), path('b', 20, 0, 10)] }
  const clip = copySelection(doc([g]), new Set(['g', 'a']))
  assert.ok(clip)
  assert.deepEqual(
    clip.items.map((i) => i.id),
    ['g'],
  )
})

test('raw markup that uses a gradient from the drawing takes that defs item along', () => {
  const defs = raw('r1', '<defs><linearGradient id="lg"><stop offset="0" stop-color="#f00"/></linearGradient></defs>')
  const text = raw('r2', '<text x="5" y="5" fill="url(#lg)">hi</text>')
  const clip = copySelection(doc([defs, path('p', 0, 0, 10), text]), new Set(['r2']))
  assert.ok(clip)
  assert.deepEqual(
    clip.items.map((i) => i.id),
    ['r1', 'r2'],
  )
  assert.match(clip.svg, /id="lg"/)
  // Nothing measurable: the drawing's frame.
  assert.deepEqual(viewBoxOf(clip.svg), [0, 0, 100, 100])
})

test('nothing selected copies nothing', () => {
  assert.equal(copySelection(doc([path('a', 0, 0, 10)]), new Set()), null)
})

/* --------------------------------------------------------------- paste */

test('pastes next to the originals step on: 1, 2, 3 steps', () => {
  const d = doc([path('a', 0, 0, 10)])
  let clip = copySelection(d, new Set(['a']))
  assert.ok(clip)
  const steps: number[] = []
  for (let i = 0; i < 3; i++) {
    const n = nextPaste(clip, d)
    steps.push(n.steps)
    clip = n.clip
  }
  assert.deepEqual(steps, [1, 2, 3])
})

test('after a cut the first paste lands IN PLACE, later ones step on from there', () => {
  const d = doc([path('a', 0, 0, 10), path('b', 50, 50, 10)])
  let clip = copySelection(d, new Set(['a']))
  assert.ok(clip)
  const cut = { ...d, items: removeItems(d.items, new Set(['a'])) }
  const first = nextPaste(clip, cut)
  assert.equal(first.steps, 0)
  clip = first.clip
  const pasted = pasteClip(cut, clip, first.steps)
  assert.ok(pasted)
  // The originals are still gone after the first paste; the count, not a
  // second look, decides the next step.
  assert.equal(nextPaste(clip, pasted.doc).steps, 1)
  assert.deepEqual(selectionBox(pasted.doc.items, pasted.ids), { x: 0, y: 0, w: 10, h: 10 })
})

test('a paste gets fresh ids, becomes the selection, and moves by its step', () => {
  const d = doc([path('a', 0, 0, 10), textGroup('t')])
  const clip = copySelection(d, new Set(['a', 't']))
  assert.ok(clip)
  const res = pasteClip(d, clip, 2)
  assert.ok(res)
  const ids = allIds(res.doc.items)
  assert.equal(new Set(ids).size, ids.length, `ids unique: ${ids.join(',')}`)
  assert.equal(res.ids.size, 2)
  for (const id of res.ids) assert.ok(!['a', 't'].includes(id))
  const step = 2 * pasteStep(d)
  const box = selectionBox(res.doc.items, res.ids)
  assert.ok(box)
  assert.equal(box.x, step)
  assert.equal(box.y, step)
  // The live text is still live text, and its matrix moved with its outlines.
  const t = res.doc.items.find((i) => res.ids.has(i.id) && i.kind === 'group') as GroupItem
  assert.ok(t.text, 'still a text')
  assert.deepEqual(t.text.matrix, [1, 0, 0, 1, 10 + step, 20 + step])
  assert.ok(t.children[0].id.startsWith(`${t.id}~`), 'glyph ids follow their text')
  // The originals are untouched.
  assert.deepEqual(itemBox(findItem(res.doc.items, 'a') as DocItem), { x: 0, y: 0, w: 10, h: 10 })
})

test('a gradient fill and a stroke travel with the pasted shape', () => {
  const g = { type: 'linear' as const, x1: 0, y1: 0, x2: 10, y2: 0, stops: [{ offset: 0, color: '#000000' }] }
  const stroke = { color: '#00ff00', width: 2, cap: 'round' as const, join: 'round' as const }
  const d = doc([path('a', 0, 0, 10, { gradient: g, stroke })])
  const clip = copySelection(d, new Set(['a']))
  assert.ok(clip)
  const res = pasteClip(d, clip, 1)
  assert.ok(res)
  const p = findItem(res.doc.items, [...res.ids][0]) as PathItem
  const s = pasteStep(d)
  assert.equal(p.gradient?.type, 'linear')
  assert.equal((p.gradient as typeof g).x1, s)
  assert.equal(p.stroke?.width, 2)
})

/* ---------------------------------------------------------- foreign SVG */

const svg = (body: string, vb = '0 0 24 24') => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}">${body}</svg>`

test('a foreign SVG of several shapes arrives as ONE group', () => {
  const f = readForeignSvg(svg('<path d="M2 2H10V10H2Z"/><path d="M12 12H22V22H12Z"/>'))
  assert.ok(f)
  assert.equal(f.item.kind, 'group')
  assert.equal((f.item as GroupItem).children.length, 2)
  assert.deepEqual(f.frame, { x: 2, y: 2, w: 20, h: 20 })
})

test('a single shape arrives as itself; text that is not SVG is not a paste', () => {
  const f = readForeignSvg(svg('<path d="M2 2H10V10H2Z"/>'))
  assert.ok(f)
  assert.equal(f.item.kind, 'path')
  assert.equal(readForeignSvg('hello world'), null)
  assert.equal(readForeignSvg('<div>not svg</div>'), null)
  assert.equal(readForeignSvg(svg('')), null)
})

test('raw markup that paints is fitted by the document frame (it has no box)', () => {
  const f = readForeignSvg(svg('<text x="2" y="12">hi</text><path d="M2 2H4V4H2Z"/>', '0 0 48 24'))
  assert.ok(f)
  assert.deepEqual(f.frame, { x: 0, y: 0, w: 48, h: 24 })
})

test('placement: centred as is, shrunk when huge, enlarged when a speck', () => {
  const view = { x: 0, y: 0, w: 100, h: 100 }
  // Fits: same size, centred.
  assert.deepEqual(placeForeign({ x: 0, y: 0, w: 40, h: 20 }, view), [1, 0, 0, 1, 30, 40])
  // Huge (wider than the view): 80% of the view on its long side.
  const [k] = placeForeign({ x: 0, y: 0, w: 1000, h: 200 }, view)
  assert.ok(Math.abs(k - 0.08) < 1e-12)
  // A 24-unit icon into a 1024 board: a quarter of it, centred.
  const t = placeForeign({ x: 0, y: 0, w: 24, h: 24 }, { x: 0, y: 0, w: 1024, h: 1024 })
  assert.ok(Math.abs(t[0] * 24 - 256) < 1e-9)
  assert.ok(Math.abs(t[4] + 12 * t[0] - 512) < 1e-9, 'centred')
  // A degenerate frame (a dot) is not scaled to infinity.
  assert.equal(placeForeign({ x: 5, y: 5, w: 0, h: 0 }, view)[0], 1)
})

test('a foreign paste lands centred in the view, ids fresh', () => {
  const d = doc([path('p1', 0, 0, 10)])
  const f = readForeignSvg(svg('<path d="M0 0H10V10H0Z"/><path d="M14 14H24V24H14Z"/>'))
  assert.ok(f)
  const res = insertPasted(d, [f.item], placeForeign(f.frame, { x: 0, y: 0, w: 100, h: 100 }))
  assert.ok(res)
  const ids = allIds(res.doc.items)
  assert.equal(new Set(ids).size, ids.length, `ids unique: ${ids.join(',')}`)
  assert.deepEqual(selectionBox(res.doc.items, res.ids), { x: 38, y: 38, w: 24, h: 24 })
})

/* -------------------------------------------------------------- raw ids */

test('a pasted raw id already in the drawing is renamed, with every reference to it', () => {
  const existing = [raw('r0', '<defs><clipPath id="a"><rect width="5" height="5"/></clipPath></defs>')]
  const pasted: DocItem[] = [
    raw('r1', '<defs><clipPath id="a"><rect width="9" height="9"/></clipPath><pattern id="b"/></defs>'),
    raw('r2', `<use href="#a"/><use xlink:href='#a'/><rect fill="url(#b)" clip-path="url('#a')"/>`, {
      inherited: { 'clip-path': 'url(#a)' },
    }),
  ]
  const out = renameRawIds(pasted, takenIds(existing)) as RawItem[]
  assert.match(out[0].markup, /id="a-2"/)
  assert.match(out[0].markup, /id="b"/, 'a free id is kept')
  assert.equal(
    out[1].markup,
    `<use href="#a-2"/><use xlink:href='#a-2'/><rect fill="url(#b)" clip-path="url('#a-2')"/>`,
  )
  assert.deepEqual(out[1].inherited, { 'clip-path': 'url(#a-2)' })
})

test('a reference to an id the paste does not define points at the drawing, and stays', () => {
  const pasted = [raw('r', '<text fill="url(#lg)">hi</text>')]
  assert.equal(renameRawIds(pasted, new Set(['lg'])), pasted, 'unchanged')
})

test('a rename never lands on another taken or pasted id', () => {
  const out = renameRawIds([raw('r', '<g id="a"/><g id="a-2"/>')], new Set(['a', 'a-3'])) as RawItem[]
  assert.equal(out[0].markup, '<g id="a-4"/><g id="a-2"/>')
})

test('`data-id` and other look-alikes are not ids', () => {
  const out = renameRawIds([raw('r', '<g data-id="a" id="a"/>')], new Set(['a'])) as RawItem[]
  assert.equal(out[0].markup, '<g data-id="a" id="a-2"/>')
})

test('a gradient path in the drawing reserves the paint-server id it is written with', () => {
  const g = { type: 'linear' as const, x1: 0, y1: 0, x2: 1, y2: 0, stops: [] }
  assert.ok(takenIds([path('p3', 0, 0, 1, { gradient: g })]).has('grad-p3'))
})

test('the pasted copy of a raw item next to its original gets its own ids', () => {
  const d = doc([raw('r1', '<defs><linearGradient id="lg"/></defs>'), raw('r2', '<text fill="url(#lg)">hi</text>')])
  const clip = copySelection(d, new Set(['r2']))
  assert.ok(clip)
  const res = pasteClip(d, clip, 1)
  assert.ok(res)
  const pasted = res.doc.items.filter((i) => res.ids.has(i.id)) as RawItem[]
  assert.equal(pasted.length, 2)
  assert.match(pasted[0].markup, /<defs><linearGradient id="lg-2"\/><\/defs>/)
  assert.match(pasted[1].markup, /<text fill="url\(#lg-2\)">hi<\/text>/)
})

test('our own markup reads back as a foreign SVG of the same shapes', () => {
  const d = doc([path('a', 10, 10, 20), path('b', 40, 10, 20)])
  const clip = copySelection(d, new Set(['a', 'b']))
  assert.ok(clip)
  assert.equal(clip.svg, clipMarkup(clip.items, d.viewBox))
  const f = readForeignSvg(clip.svg)
  assert.ok(f)
  assert.deepEqual(f.frame, { x: 10, y: 10, w: 50, h: 20 })
})

/* --------------------------------------------------- review regressions */

const clipBox = (g: GroupItem) => {
  const pts = g.clip!.flatMap((c) => c.subPaths.flatMap((sp) => sp.nodes))
  return [Math.min(...pts.map((p) => p.x)), Math.min(...pts.map((p) => p.y)), Math.max(...pts.map((p) => p.x))]
}

test('a pasted clip group brings its clip along: in-app paste and a foreign clipped SVG', () => {
  const g: GroupItem = {
    kind: 'group',
    id: 'g',
    visible: true,
    clip: [{ rule: 'nonzero', subPaths: square(10, 10, 20) }],
    children: [path('a', 10, 10, 20)],
  }
  const d = doc([g])
  const clip = copySelection(d, new Set(['g']))
  assert.ok(clip)
  const res = pasteClip(d, clip, 1)
  assert.ok(res)
  const pasted = findItem(res.doc.items, [...res.ids][0]) as GroupItem
  const child = pasted.children[0] as PathItem
  // The clip moved exactly as far as the art it clips.
  assert.deepEqual(clipBox(pasted), [
    child.subPaths[0].nodes[0].x,
    child.subPaths[0].nodes[0].y,
    child.subPaths[0].nodes[1].x,
  ])

  const f = readForeignSvg(
    svg(
      '<defs><clipPath id="c"><rect width="24" height="24"/></clipPath></defs>' +
        '<g clip-path="url(#c)"><rect x="2" y="2" width="20" height="20" fill="#f00"/></g>',
    ),
  )
  assert.ok(f)
  const placed = insertPasted(
    doc([], [0, 0, 512, 512]),
    [f.item],
    placeForeign(f.frame, { x: 0, y: 0, w: 512, h: 512 }),
  )
  assert.ok(placed)
  const fg = findItem(placed.doc.items, [...placed.ids][0]) as GroupItem
  const art = itemBox(fg)
  assert.ok(art && art.w > 100, 'the paste is visible: its clip lies over its art')
  const [cx0, cy0, cx1] = clipBox(fg)
  assert.ok(cx0 < art.x + 1 && cy0 < art.y + 1 && cx1 > art.x + art.w - 1)
})

test("Duplicate renames a raw item's ids, as Paste does", async () => {
  const { duplicateSelected } = await import('../src/components/editor/selectionOps.ts')
  const d = doc([raw('r', '<g><linearGradient id="lg"/><rect fill="url(#lg)"/></g>')])
  const res = duplicateSelected(d, new Set(['r']))
  assert.ok(res)
  const copy = findItem(res.doc.items, [...res.ids][0]) as RawItem
  assert.match(copy.markup, /id="lg-2"/)
  assert.match(copy.markup, /url\(#lg-2\)/)
})

test('copy follows a gradient that hrefs another for its stops, defined in a separate raw item', () => {
  const d = doc([
    raw('d1', '<linearGradient id="base"><stop offset="0" stop-color="#f00"/></linearGradient>'),
    raw('d2', '<linearGradient id="lg" href="#base"/>'),
    raw('s', '<rect width="10" height="10" fill="url(#lg)"/>'),
  ])
  const clip = copySelection(d, new Set(['s']))
  assert.ok(clip)
  assert.deepEqual(
    clip.items.map((it) => it.id),
    ['d1', 'd2', 's'],
  )
})

test('an invisible box in a pasted SVG does not frame it: the art does', () => {
  const f = readForeignSvg(
    svg(
      '<rect x="10" y="10" width="20" height="20" fill="#f00"/><rect x="5" y="5" width="30" height="30" fill="none"/>',
      '0 0 1000 1000',
    ),
  )
  assert.ok(f)
  assert.deepEqual(f.frame, { x: 10, y: 10, w: 20, h: 20 })
})

test("a paste event falls back to the editor's copy only when the clipboard is empty", async () => {
  const { pasteEventText } = await import('../src/components/editor/clipboard.ts')
  assert.equal(
    pasteEventText([], () => ''),
    null,
  )
  // A screenshot on the clipboard: something the user copied, not ours to replace.
  assert.equal(
    pasteEventText(['Files'], () => ''),
    '',
  )
  assert.equal(
    pasteEventText(['text/plain'], () => '<svg/>'),
    '<svg/>',
  )
})
