// The logos-cc0 corpus's rules (bench/compare/logosCc0.ts) and its frozen manifest. The
// sample is a held-out headline, so two things must hold: the rules screen and stratify a
// file the way the header says, and the checked-in sample is exactly what those rules pick
// from the manifest's own rows — no hand edits, no drift after a rule change.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  LOGOS_COMMIT,
  SAMPLE_SIZE,
  allocate,
  bucketOf,
  brandKey,
  galleryKeys,
  kindOf,
  normPaint,
  paints,
  screen,
  stratifiedSample,
  stratumKey,
  untar,
  type Strata,
} from '../bench/compare/logosCc0.ts'
import { corpusOrder } from '../bench/compare/report.ts'

test('screen names embedded rasters, live text and external references; internal refs pass', () => {
  assert.match(screen('<svg><image href="data:image/png;base64,AA"/></svg>') ?? '', /embedded raster/)
  assert.match(screen('<svg><text>Hi</text></svg>') ?? '', /live text/)
  assert.match(screen('<svg><use xlink:href="other.svg#a"/></svg>') ?? '', /external reference/)
  assert.match(screen('<svg><path fill="url(http://x/y.svg#g)"/></svg>') ?? '', /external reference/)
  assert.equal(screen('<svg><use href="#a"/><path fill="url(#g)"/></svg>'), null)
  // A commented-out <text> is not live text.
  assert.equal(screen('<svg><!-- <text>x</text> --><path d="M0 0"/></svg>'), null)
})

test('normPaint folds hex shorthands, rgb() and names to one spelling', () => {
  assert.equal(normPaint('#FFF'), '#ffffff')
  assert.equal(normPaint('#ff000080'), '#ff0000')
  assert.equal(normPaint('rgb(255, 0, 0)'), '#ff0000')
  assert.equal(normPaint('red'), '#ff0000')
  assert.equal(normPaint('none'), null)
  assert.equal(normPaint("url('#g1')"), 'url(#g1)')
})

test('paints follows inheritance, CSS classes and skips clip/mask contents', () => {
  const svg = `<svg><style>.a{fill:#00f}</style>
    <g fill="#f00"><path d="M0 0"/><rect class="a"/></g>
    <clipPath id="c"><rect fill="#0f0"/></clipPath>
    <circle style="fill:url(#g)" stroke="#000"/>
    <path/></svg>`
  const p = paints(svg)
  assert.deepEqual(p.solid, ['#000000', '#0000ff', '#ff0000'])
  assert.deepEqual(p.gradients, ['url(#g)'])
})

test('a file that names no paint is one colour (the default black)', () => {
  assert.deepEqual(paints('<svg><path d="M0 0"/></svg>').solid, ['#000000'])
})

test('buckets and kind', () => {
  assert.deepEqual([1, 2, 3, 4, 8, 9, 40].map(bucketOf), ['1', '2-3', '2-3', '4-8', '4-8', '9+', '9+'])
  assert.equal(kindOf('x-icon.svg', 900, 100), 'symbol')
  assert.equal(kindOf('x.svg', 512, 256), 'wordmark')
  assert.equal(kindOf('x.svg', 512, 300), 'symbol')
})

test('allocate: floors, proportional rest, exact total, never past a stratum', () => {
  const sizes = new Map([
    ['a', 1000],
    ['b', 100],
    ['c', 2],
  ])
  const got = allocate(sizes, 100, 4)
  assert.equal(
    [...got.values()].reduce((a, b) => a + b, 0),
    100,
  )
  assert.equal(got.get('c'), 2)
  assert.ok((got.get('b') ?? 0) >= 4)
  assert.ok((got.get('a') ?? 0) > (got.get('b') ?? 0))
  // More asked than exists: everything.
  assert.deepEqual([...allocate(sizes, 5000).values()], [1000, 100, 2])
})

test('stratifiedSample is deterministic and order-independent', () => {
  const rows = Array.from({ length: 50 }, (_, i) => ({ file: `f${i}.svg`, stratum: i % 3 ? 'x' : 'y' }))
  const a = stratifiedSample(rows, 10, 2)
  const b = stratifiedSample(rows.slice().reverse(), 10, 2)
  assert.equal(a.sample.size, 10)
  assert.deepEqual([...a.sample].sort(), [...b.sample].sort())
})

test('brand keys match across spellings, gallery stems drop -wm', () => {
  assert.equal(brandKey('Coca-Cola'), brandKey('coca_cola'))
  const keys = galleryKeys([{ file: 'fedex-wm.svg', company: 'FedEx' }])
  assert.ok(keys.has('fedex'))
})

test('untar reads ustar files and pax long paths', () => {
  const block = (name: string, size: number, type: string): Uint8Array => {
    const h = new Uint8Array(512)
    h.set(new TextEncoder().encode(name.slice(0, 100)), 0)
    h.set(new TextEncoder().encode(`${size.toString(8).padStart(11, '0')}\0`), 124)
    h[156] = type.charCodeAt(0)
    return h
  }
  const pad = (b: Uint8Array): Uint8Array => {
    const out = new Uint8Array(Math.ceil(b.length / 512) * 512)
    out.set(b)
    return out
  }
  const long = `root/${'d'.repeat(120)}/x.svg`
  const pax = new TextEncoder().encode(`${long.length + 9} path=${long}\n`)
  const body = new TextEncoder().encode('<svg/>')
  const tar = new Uint8Array([
    ...block('pax', pax.length, 'x'),
    ...pad(pax),
    ...block('short', body.length, '0'),
    ...pad(body),
    ...block('root/a.svg', body.length, '0'),
    ...pad(body),
    ...new Uint8Array(1024),
  ])
  const files = untar(tar)
  assert.deepEqual(
    files.map((f) => f.path),
    [long, 'root/a.svg'],
  )
  assert.equal(new TextDecoder().decode(files[1].data), '<svg/>')
})

test('report prints headline corpora first, then held out, then in-sample', () => {
  const r = (corpus: string, heldOut: boolean) => ({ corpus, heldOut }) as never
  assert.deepEqual(
    corpusOrder([r('truth0', false), r('svgemoji', true), r('svgemoji-v0', true), r('logos-cc0', true)]),
    ['logos-cc0', 'svgemoji-v0', 'svgemoji', 'truth0'],
  )
})

// ── the frozen manifest
const manifest = JSON.parse(readFileSync(new URL('../bench/compare/manifests/logos-cc0.json', import.meta.url), 'utf8'))

test('manifest pins the commit, CC0, and one row per file', () => {
  assert.equal(manifest.commit, LOGOS_COMMIT)
  assert.equal(manifest.license, 'CC0-1.0')
  const files = manifest.rows.map((r: { file: string }) => r.file)
  assert.equal(new Set(files).size, files.length)
  for (const r of manifest.rows) {
    assert.match(r.sha256, /^[0-9a-f]{64}$/)
    assert.ok(r.url.includes(LOGOS_COMMIT))
    if (r.sampled) assert.equal(r.excluded, null, `${r.file} is sampled and excluded`)
  }
})

test('the sample is exactly what the rules pick from the manifest rows', () => {
  const eligible = manifest.rows.filter(
    (r: { excluded: string | null; strata: Strata | null }) => !r.excluded && r.strata,
  )
  const { sample, before, after } = stratifiedSample(
    eligible.map((r: { file: string; strata: Strata }) => ({ file: r.file, stratum: stratumKey(r.strata) })),
    SAMPLE_SIZE,
  )
  const frozen = manifest.rows.filter((r: { sampled: boolean }) => r.sampled).map((r: { file: string }) => r.file)
  assert.equal(frozen.length, SAMPLE_SIZE)
  assert.deepEqual(frozen.sort(), [...sample].sort())
  assert.deepEqual(manifest.counts.strataBefore, Object.fromEntries([...before].sort()))
  assert.deepEqual(manifest.counts.strataAfter, Object.fromEntries([...after].sort()))
  // Every exclusion is counted under its reason.
  const excluded = manifest.rows.filter((r: { excluded: string | null }) => r.excluded).length
  assert.equal(
    Object.values(manifest.counts.excluded as Record<string, number>).reduce((a, b) => a + b, 0),
    excluded,
  )
})
