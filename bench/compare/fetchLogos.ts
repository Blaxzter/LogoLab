// Fetch gilbarbara/logos at the pinned commit and freeze the logos-cc0 sample.
//
//   node --experimental-strip-types bench/compare/fetchLogos.ts [--res 512]
//   (BENCH_TOOLS=<main checkout>/.bench-tools from a worktree; paths.ts)
//
// Why this corpus: the benchmark is for a LOGO tool and the svg-emoji headline is emoji.
// gilbarbara/logos is ~2,000 authored brand-mark SVGs whose LICENSE.txt is CC0 1.0 — the
// one large logo set whose artwork licence allows rendering and re-tracing it in public.
// CC0 covers the ARTWORK (the file); it does not license the MARKS, which stay their owners'
// trademarks. The benchmark only rasterizes and re-traces them, like svg-emoji's Twemoji.
//
// Writes, under .bench-tools/datasets/gilbarbara-logos/ (gitignored):
//   raw/<sha>.tar.gz            the commit's tarball (codeload), as downloaded
//   <sha>/logos/<file>.svg      every logo, byte for byte
//   <sha>/LICENSE.txt, logos.json
// and, checked in, bench/compare/manifests/logos-cc0.json: the commit, the licence, the rules,
// the counts (excluded per reason, stratum sizes before and after sampling, ground-truth
// refusals in the sample), and one row per file — sha256, URL at the commit, strata, the
// exclusion reason or null, the svgGround refusal codes, and whether it is in the sample.
//
// The tarball's sha256 is recorded but NOT enforced: GitHub does not promise byte-stable
// archives. What corpus.ts enforces is each SVG's own sha256, which is what gets scored.
// The rules themselves (screen, strata, sample) are pure in logosCc0.ts.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { join, relative } from 'node:path'
import { ensureImageData } from '../nodeHarness.ts'
import { parseGroundTruth, refusals } from '../svgGround.ts'
import { DATASETS, REPO } from './paths.ts'
import { renderGround } from './render.ts'
import {
  FLOOR,
  LOGOS_COMMIT,
  LOGOS_REPO,
  LOGOS_TARBALL,
  SAMPLE_SIZE,
  brandKey,
  galleryKeys,
  inkFraction,
  logoUrl,
  screen,
  strataOf,
  stratumKey,
  stratifiedSample,
  untar,
  type Strata,
} from './logosCc0.ts'

ensureImageData()

const argv = process.argv.slice(2)
const RES = Number(argv[argv.indexOf('--res') + 1] || 512) || 512
const ROOT = join(DATASETS, 'gilbarbara-logos')
const DIR = join(ROOT, LOGOS_COMMIT)
const TARBALL = join(ROOT, 'raw', `${LOGOS_COMMIT}.tar.gz`)
const MANIFEST = join(REPO, 'bench', 'compare', 'manifests', 'logos-cc0.json')
/** Under this fraction of off-white pixels at RES the mark is invisible on the benchmark's paper. */
const BLANK = 0.001

const sha256 = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('hex')

interface Row {
  file: string
  brand: string | null
  sha256: string
  url: string
  strata: Strata | null
  excluded: string | null
  gtRefusal: string[]
  sampled: boolean
}

async function main(): Promise<void> {
  if (!existsSync(TARBALL)) {
    mkdirSync(join(ROOT, 'raw'), { recursive: true })
    console.log(`downloading ${LOGOS_TARBALL}`)
    const res = await fetch(LOGOS_TARBALL)
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${LOGOS_TARBALL}`)
    writeFileSync(TARBALL, new Uint8Array(await res.arrayBuffer()))
  }
  const gz = readFileSync(TARBALL)
  const entries = untar(gunzipSync(gz))
  // GitHub's archive roots everything at `<repo>-<sha>/`; anything else is not this commit.
  const root = `logos-${LOGOS_COMMIT}/`
  if (!entries.length || !entries.every((e) => e.path.startsWith(root)))
    throw new Error(`tarball is not ${LOGOS_REPO}@${LOGOS_COMMIT} — refusing (delete ${TARBALL} to re-fetch)`)
  const at = (p: string) => entries.find((e) => e.path === root + p)?.data
  const license = at('LICENSE.txt')
  if (!license || !new TextDecoder().decode(license).startsWith('CC0 1.0 Universal'))
    throw new Error('LICENSE.txt at the pinned commit is not CC0 1.0 Universal — refusing')
  const index = at('logos.json')
  if (!index) throw new Error('logos.json missing from the tarball')

  mkdirSync(join(DIR, 'logos'), { recursive: true })
  writeFileSync(join(DIR, 'LICENSE.txt'), license)
  writeFileSync(join(DIR, 'logos.json'), index)
  const brands = new Map<string, string>()
  for (const b of JSON.parse(new TextDecoder().decode(index)) as { name: string; files: string[] }[])
    for (const f of b.files) brands.set(f, b.name)
  const inSample = galleryKeys(JSON.parse(readFileSync(join(REPO, 'examples', 'logos', 'manifest.json'), 'utf8')))
  const isGallery = (file: string): boolean => {
    const name = brands.get(file)
    const stem = file.replace(/\.svg$/, '').replace(/-(icon|wordmark)$/, '')
    return (name !== undefined && inSample.has(brandKey(name))) || inSample.has(brandKey(stem))
  }

  const rows: Row[] = []
  for (const e of entries) {
    const rel = e.path.slice(root.length)
    const m = /^logos\/([^/]+\.svg)$/.exec(rel)
    if (!m) continue
    const file = m[1]
    if (file.startsWith('.') || /[\\:]/.test(file)) throw new Error(`refusing odd filename ${file}`)
    writeFileSync(join(DIR, 'logos', file), e.data)
    const svg = new TextDecoder().decode(e.data)
    const row: Row = {
      file,
      brand: brands.get(file) ?? null,
      sha256: sha256(e.data),
      url: logoUrl(file),
      strata: null,
      excluded: null,
      gtRefusal: [],
      sampled: false,
    }
    rows.push(row)
    row.excluded = screen(svg)
    if (!row.excluded && isGallery(file))
      row.excluded = 'in-sample brand (in the gallery corpus, examples/logos/manifest.json)'
    let img: { width: number; height: number; data: Uint8ClampedArray } | null = null
    try {
      img = renderGround(svg, RES)
    } catch (err) {
      row.excluded ??= `resvg cannot render (${(err as Error).message.split('\n')[0].slice(0, 60)})`
    }
    if (img) {
      row.strata = strataOf(file, svg, img.width, img.height)
      if (inkFraction(img) < BLANK) row.excluded ??= 'renders blank on white'
    }
    try {
      row.gtRefusal = [...new Set(refusals(parseGroundTruth(svg)).map((r) => r.code))]
    } catch (err) {
      row.gtRefusal = [`parse: ${(err as Error).message.slice(0, 40)}`]
    }
  }
  rows.sort((a, b) => (a.file < b.file ? -1 : 1))

  const eligible = rows.filter((r) => !r.excluded && r.strata)
  const { sample, before, after } = stratifiedSample(
    eligible.map((r) => ({ file: r.file, stratum: stratumKey(r.strata as Strata) })),
    SAMPLE_SIZE,
    FLOOR,
  )
  for (const r of rows) r.sampled = sample.has(r.file)

  const hist = (xs: string[]): Record<string, number> => {
    const h: Record<string, number> = {}
    for (const x of xs) h[x] = (h[x] ?? 0) + 1
    return Object.fromEntries(Object.entries(h).sort((a, b) => b[1] - a[1]))
  }
  const sampled = rows.filter((r) => r.sampled)
  const counts = {
    files: rows.length,
    excluded: hist(rows.filter((r) => r.excluded).map((r) => r.excluded?.replace(/ \(.*$/, '') ?? '')),
    eligible: eligible.length,
    sampled: sampled.length,
    strataBefore: Object.fromEntries([...before].sort()),
    strataAfter: Object.fromEntries([...after].sort()),
    gtRefusalInSample: hist(sampled.flatMap((r) => (r.gtRefusal.length ? r.gtRefusal : ['scorable']))),
  }
  // One row per line: a ~2,000-row manifest stays diffable without a 10k-line file.
  const head = {
    corpus: 'logos-cc0',
    repo: LOGOS_REPO,
    commit: LOGOS_COMMIT,
    commitUrl: `https://github.com/${LOGOS_REPO}/tree/${LOGOS_COMMIT}`,
    tarball: LOGOS_TARBALL,
    tarballSha256: sha256(gz),
    license: 'CC0-1.0',
    licenseSha256: sha256(license),
    note:
      'gilbarbara/logos, LICENSE.txt CC0 1.0 Universal at this commit. CC0 covers the artwork; the marks remain ' +
      "their owners' trademarks. Rendered and re-traced for measurement only. Rules in bench/compare/logosCc0.ts.",
    rules: {
      res: RES,
      sampleSize: SAMPLE_SIZE,
      floor: FLOOR,
      blankBelow: BLANK,
      strata:
        'colours = distinct solid fill/stroke paints + referenced gradients (1 | 2-3 | 4-8 | 9+); gradients = any ' +
        '<linear|radialGradient>; kind = -icon file → symbol, else rendered w/h ≥ 2 → wordmark, else symbol',
      order: 'within each stratum by sha1(file); allocation = floor min(n, 4) + proportional largest remainder',
    },
    counts,
  }
  const json = `${JSON.stringify(head, null, 1).replace(/\n}$/, '')},\n "rows": [\n${rows.map((r) => `  ${JSON.stringify(r)}`).join(',\n')}\n ]\n}\n`
  writeFileSync(MANIFEST, json)
  console.log(JSON.stringify(counts, null, 1))
  console.log(`wrote ${relative(REPO, MANIFEST)} (${rows.length} rows, ${sampled.length} sampled)`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
