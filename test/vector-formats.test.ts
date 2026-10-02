// The DXF and AI downloads (src/lib/export/vectorFormats.ts). What this pins: the
// files are structurally valid (DXF group pairs, PDF xref offsets that point at
// their objects), DXF is upright (y flipped) with one layer per colour, and what
// the SVG export leaves out — hidden items, unmodelled markup — stays out.
// Checked against real readers once (PyMuPDF renders the .ai within 1.4/255 of
// resvg on the nebula gradient trace; ezdxf audits every DXF clean), which a
// unit test can't run.
//
//   node --test test/vector-formats.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { docToAi, docToDxf, docToPdf, nearestAci, unsupportedItemCount } from '../src/lib/export/vectorFormats.ts'
import type { EditableDoc, PathItem, PathNode } from '../src/lib/path/types.ts'

const node = (x: number, y: number, hIn: PathNode['hIn'] = null, hOut: PathNode['hOut'] = null): PathNode => ({
  x,
  y,
  hIn,
  hOut,
  kind: 'corner',
})

const path = (id: string, fill: string, sub: PathNode[][], extra: Partial<PathItem> = {}): PathItem => ({
  kind: 'path',
  id,
  fill,
  fillRule: 'nonzero',
  subPaths: sub.map((nodes) => ({ nodes, closed: true })),
  visible: true,
  ...extra,
})

const square = [node(10, 10), node(90, 10), node(90, 90), node(10, 90)]
const hole = [node(30, 30), node(30, 70), node(70, 70), node(70, 30)]
const arc = [node(10, 95, null, { x: 40, y: 80 }), node(90, 95, { x: 60, y: 80 }, null)]

const DOC: EditableDoc = {
  viewBox: [0, 0, 100, 100],
  items: [
    path('ring', '#ff0000', [square, hole], { fillRule: 'evenodd' }),
    {
      kind: 'group',
      id: 'g',
      opacity: 0.5,
      visible: true,
      children: [
        {
          ...path('line', 'none', []),
          subPaths: [{ nodes: arc, closed: false }],
          stroke: { color: '#0000ff', width: 4, cap: 'round', join: 'round' },
        },
      ],
    },
    path('hidden', '#00ff00', [square], { visible: false }),
    { kind: 'raw', id: 'txt', markup: '<text>hi</text>', visible: true },
    path('glow', '#888888', [square], {
      gradient: {
        type: 'radial',
        cx: 50,
        cy: 50,
        r: 40,
        stops: [
          { offset: 0, color: '#ffffff', opacity: 0.5 },
          { offset: 1, color: '#ffffff', opacity: 0 },
        ],
      },
    }),
  ],
}

/** DXF as [code, value] pairs. */
function pairs(dxf: string): [number, string][] {
  const lines = dxf.split('\r\n')
  assert.equal(lines.pop(), '', 'ends with a line break')
  assert.equal(lines.length % 2, 0, 'group codes and values pair up')
  const out: [number, string][] = []
  for (let i = 0; i < lines.length; i += 2) out.push([Number(lines[i]), lines[i + 1]])
  return out
}

test('DXF: R12, one layer per colour, upright, hidden and raw items left out', () => {
  const p = pairs(docToDxf(DOC))
  assert.deepEqual(p.at(-1), [0, 'EOF'])
  assert.ok(p.some(([c, v], i) => c === 9 && v === '$ACADVER' && p[i + 1][1] === 'AC1009'))

  const layers = p.filter(([c], i) => c === 2 && p[i - 1]?.[1] === 'LAYER').map(([, v]) => v)
  assert.deepEqual(layers.sort(), ['0', 'FILL_888888', 'FILL_FF0000', 'STROKE_0000FF'])
  assert.ok(!p.some(([c, v]) => c === 8 && v === 'FILL_00FF00'), 'hidden path is not exported')

  // Polylines: the ring's two loops closed, the stroke's centreline open.
  const polys = p.flatMap(([c, v], i) => (c === 0 && v === 'POLYLINE' ? [i] : []))
  assert.equal(polys.length, 4)
  const flags = polys.map((i) => p.slice(i).find(([c]) => c === 70)![1])
  assert.deepEqual(flags, ['1', '1', '0', '1'])

  // y is flipped: the square's top edge (y = 10) lands at 90.
  const ys = p.filter(([c], i) => c === 20 && p[i - 3]?.[1] === 'VERTEX').map(([, v]) => Number(v))
  assert.ok(ys.includes(90) && ys.includes(10))
  // The curve is flattened into many vertices, all within the drawing.
  const strokeVerts = p.filter(([c, v], i) => c === 0 && v === 'VERTEX' && p[i + 1][1] === 'STROKE_0000FF')
  assert.ok(strokeVerts.length > 8, `curve flattened (${strokeVerts.length} vertices)`)
  assert.ok(ys.every((y) => y >= 0 && y <= 100))
})

test('DXF: nearest ACI colours', () => {
  assert.equal(nearestAci('#ff0000'), 1)
  assert.equal(nearestAci('#0000ff'), 5)
  assert.equal(nearestAci('#000000'), 7)
  assert.equal(nearestAci('#ffffff'), 255)
})

test('AI: a PDF whose xref points at every object', () => {
  const bytes = docToAi(DOC, 'Logo (test)')
  const pdf = new TextDecoder('latin1').decode(bytes)
  assert.ok(pdf.startsWith('%PDF-1.4\n'))
  assert.ok(pdf.endsWith('%%EOF\n'))

  const startxref = Number(/startxref\n(\d+)/.exec(pdf)![1])
  assert.ok(pdf.startsWith('xref\n', startxref), 'startxref points at the table')
  const offsets = [...pdf.slice(startxref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]))
  offsets.forEach((o, i) => assert.ok(pdf.startsWith(`${i + 1} 0 obj\n`, o), `object ${i + 1} at its offset`))

  // Every stream's /Length is its byte count.
  for (const m of pdf.matchAll(/\/Length (\d+) >>\nstream\n/g)) {
    const start = m.index! + m[0].length
    assert.equal(pdf.slice(start + Number(m[1]), start + Number(m[1]) + 10), '\nendstream')
  }

  assert.match(pdf, /\/MediaBox \[0 0 100 100\]/)
  assert.match(pdf, /\/Title \(Logo \\\(test\\\)\)/)
  // Even-odd ring, round-capped stroke at the group's opacity, glow under a soft mask.
  assert.match(pdf, /\nf\*\n/)
  assert.match(pdf, /1 J\n1 j/)
  assert.match(pdf, /\/CA 0\.5/)
  assert.match(pdf, /\/SMask << \/Type \/Mask \/S \/Luminosity/)
  assert.match(pdf, /\/ShadingType 3 \/ColorSpace \/DeviceGray/)
  assert.ok(!pdf.includes('0 1 0 rg'), 'hidden green path is not exported')
})

test('the .ai and the .pdf are the same file', () => {
  assert.deepEqual(docToAi(DOC, 'x'), docToPdf(DOC, 'x'))
})

test('unsupportedItemCount counts visible unmodelled markup', () => {
  assert.equal(unsupportedItemCount(DOC), 1)
})
