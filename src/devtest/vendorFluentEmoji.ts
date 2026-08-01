// Vendor tier 1 of the ground-truth corpus: Microsoft Fluent Emoji, "Color" style (MIT).
//
//   node --experimental-strip-types src/devtest/vendorFluentEmoji.ts [--limit N] [--refresh]
//
// Writes:
//   public/corpus/fluent/color/<slug>.svg   the gradient art (the case)
//   public/corpus/fluent/flat/<slug>.svg    the SAME glyph's Flat variant (the A/B control)
//   public/corpus/fluent/NOTICE             MIT, as the licence requires
//   public/corpus/fluent/manifest.json      every triage verdict + the refusal histogram
//   src/devtest/fluentCorpus.ts             GENERATED TruthCase[] — imported by truthCorpus.ts
//
// ---------------------------------------------------------------------------
// Why this triages instead of just downloading
//
// Fluent's Color SVGs are Figma exports, and most of them are NOT usable as ground truth —
// not because they are bad art, but because their VISIBLE boundary is not the boundary the
// authored path data describes. svgGround.refusals() names each reason; this script runs it
// over every candidate and only vendors the survivors, so a glyph the parser would have to
// GUESS at never enters the corpus in the first place.
//
// The refusal histogram it prints is itself a finding: it says what svgGround would have to
// learn next to grow the corpus, ranked by how much art each feature would unlock.
//
// DETERMINISM: the sample is ordered by a stable hash of the glyph name, never Math.random,
// so re-running with a bigger --limit EXTENDS the corpus instead of reshuffling it (every
// case that was in the old sample is still in the new one, still under the same name).
// ---------------------------------------------------------------------------

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseGroundTruth, refusals, type RefusalCode } from './svgGround.ts'

/** Pinned. A corpus that tracks a moving branch is not a corpus. */
const SHA = '62ecdc0d7ca5c6df32148c169556bc8d3782fca4'
const REPO = 'microsoft/fluentui-emoji'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const OUT = join(root, 'public', 'corpus', 'fluent')
/** Downloads are cached so re-running (or raising --limit) does not re-fetch ~1,600 files. */
const CACHE = join(root, '.cache', 'fluent-emoji')

const argv = process.argv.slice(2)
const LIMIT = Number(argv[argv.indexOf('--limit') + 1]) || 120
const REFRESH = argv.includes('--refresh')

// ---------------------------------------------------------------------------

/** FNV-1a. Stable across runs and machines — unlike Math.random or Set iteration order. */
function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return h >>> 0
}

const slugify = (name: string): string =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

const rawUrl = (path: string): string =>
  `https://raw.githubusercontent.com/${REPO}/${SHA}/${path.split('/').map(encodeURIComponent).join('/')}`

async function fetchCached(path: string): Promise<string> {
  const key = join(CACHE, path.replace(/[^\w.-]+/g, '_'))
  if (!REFRESH && existsSync(key)) return readFileSync(key, 'utf8')
  const res = await fetch(rawUrl(path))
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`)
  const text = await res.text()
  mkdirSync(CACHE, { recursive: true })
  writeFileSync(key, text)
  return text
}

/** Run `jobs` with bounded concurrency, in order. */
async function pool<T, R>(items: T[], n: number, job: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      for (;;) {
        const i = next++
        if (i >= items.length) return
        out[i] = await job(items[i], i)
      }
    }),
  )
  return out
}

// ---------------------------------------------------------------------------
// 1. The candidate pool
// ---------------------------------------------------------------------------

interface TreeEntry { path: string; type: string }

const tree: { tree: TreeEntry[]; truncated: boolean } = await (
  await fetch(`https://api.github.com/repos/${REPO}/git/trees/${SHA}?recursive=1`)
).json()
if (tree.truncated) throw new Error('git tree truncated — the candidate pool would be silently incomplete')

/**
 * Skin-tone variants are the same drawing five times over. Keeping them would spend the
 * corpus budget on near-duplicates, so only the tone-less glyph (or its `Default`) is a
 * candidate — `assets/<Name>/Color/…` and `assets/<Name>/Default/Color/…`, never `…/Dark/…`.
 */
const SKIN = /\/(Light|Medium-Light|Medium|Medium-Dark|Dark)\/Color\//
const candidates = tree.tree
  .filter((e) => e.type === 'blob' && e.path.endsWith('.svg') && e.path.includes('/Color/') && !SKIN.test(e.path))
  .map((e) => ({ name: e.path.split('/')[1], color: e.path, flat: e.path.replace(/\/Color\//, '/Flat/').replace(/_color/g, '_flat') }))
  .sort((a, b) => hash(a.name) - hash(b.name) || (a.name < b.name ? -1 : 1))

console.log(`candidate pool: ${candidates.length} glyphs (Color style, skin-tone duplicates excluded)`)
console.log(`pinned at ${REPO}@${SHA.slice(0, 10)}\n`)

// ---------------------------------------------------------------------------
// 2. Triage — every candidate, verdict written to disk
// ---------------------------------------------------------------------------

interface Verdict {
  name: string
  slug: string
  /** null ⇒ scorable. */
  refusedColor: RefusalCode[]
  refusedFlat: RefusalCode[]
  shapes: number
  nodes: number
  /** Does the Color art actually use gradients? A Color glyph with none is not a tier-1 case. */
  gradients: number
  vendored: boolean
}

console.log('triaging (downloading; cached under .cache/fluent-emoji)…')
let done = 0
const verdicts = await pool(candidates, 10, async (c): Promise<Verdict | null> => {
  let colorSvg: string
  try { colorSvg = await fetchCached(c.color) } catch { return null }
  if (++done % 200 === 0) console.log(`  … ${done}/${candidates.length}`)

  const gtC = parseGroundTruth(colorSvg)
  const refC = refusals(gtC).map((r) => r.code)

  // Only pay for the Flat twin when the Color art is usable — that is the A/B control, and a
  // control for a case we cannot score is worth nothing.
  let refF: RefusalCode[] = ['unmodelled']
  if (refC.length === 0) {
    try {
      const flatSvg = await fetchCached(c.flat)
      refF = refusals(parseGroundTruth(flatSvg)).map((r) => r.code)
    } catch { refF = ['empty'] }
  }

  return {
    name: c.name,
    slug: slugify(c.name),
    refusedColor: refC,
    refusedFlat: refF,
    shapes: gtC.shapes.length,
    nodes: gtC.shapes.reduce((n, s) => n + s.subPaths.reduce((m, sp) => m + sp.nodes.length, 0), 0),
    gradients: (colorSvg.match(/<(linear|radial)Gradient/g) ?? []).length,
    vendored: false,
  }
})

const all = verdicts.filter((v): v is Verdict => v !== null)

// The histogram is over EVERY reason each glyph fails, not just the first — "what would
// svgGround have to learn to unlock more art" is the question it needs to answer.
const hist = new Map<RefusalCode, number>()
for (const v of all) for (const code of new Set(v.refusedColor)) hist.set(code, (hist.get(code) ?? 0) + 1)

const scorable = all.filter((v) => v.refusedColor.length === 0)
/** A tier-1 case must actually BE gradient art — a few Color glyphs are flat. */
const gradientArt = scorable.filter((v) => v.gradients > 0)
const paired = gradientArt.filter((v) => v.refusedFlat.length === 0)

console.log(`\n━━━ TRIAGE — ${all.length} candidates ━━━`)
console.log(`  scorable by svgGround ......... ${scorable.length}  (${((scorable.length / all.length) * 100).toFixed(1)}%)`)
console.log(`    …of which carry gradients ... ${gradientArt.length}   ← the tier-1 pool`)
console.log(`    …with a scorable Flat twin .. ${paired.length}   ← the flat↔gradient A/B pool`)
console.log(`  REFUSED ...................... ${all.length - scorable.length}`)
for (const [code, n] of [...hist.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${String(n).padStart(5)}  ${code}${code === 'filtered' ? '   ← teaching svgGround inner shadows would unlock these' : ''}`)
}

// ---------------------------------------------------------------------------
// 3. Vendor the sample
// ---------------------------------------------------------------------------

// Prefer glyphs that have a Flat twin: the A/B pair is half the point of this tier.
const sample = [...paired, ...gradientArt.filter((v) => v.refusedFlat.length > 0)].slice(0, LIMIT)

mkdirSync(join(OUT, 'color'), { recursive: true })
mkdirSync(join(OUT, 'flat'), { recursive: true })

for (const v of sample) {
  const c = candidates.find((x) => x.name === v.name)!
  writeFileSync(join(OUT, 'color', `${v.slug}.svg`), await fetchCached(c.color))
  if (v.refusedFlat.length === 0) writeFileSync(join(OUT, 'flat', `${v.slug}.svg`), await fetchCached(c.flat))
  v.vendored = true
}

const pairedCount = sample.filter((v) => v.refusedFlat.length === 0).length
console.log(`\nvendored ${sample.length} Color SVGs + ${pairedCount} Flat twins → public/corpus/fluent/`)

writeFileSync(
  join(OUT, 'NOTICE'),
  `Microsoft Fluent Emoji
https://github.com/${REPO}
Pinned at commit ${SHA}

Copyright (c) Microsoft Corporation.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

The SVGs under ./color and ./flat are unmodified copies of the upstream files.
They are a SAMPLE: see manifest.json for the full triage of every candidate,
including the ones deliberately excluded and why.
`,
)

writeFileSync(
  join(OUT, 'manifest.json'),
  JSON.stringify(
    {
      source: { repo: REPO, sha: SHA, style: 'Color', licence: 'MIT' },
      generatedBy: 'src/devtest/vendorFluentEmoji.ts',
      candidates: all.length,
      scorable: scorable.length,
      gradientArt: gradientArt.length,
      pairedWithFlat: paired.length,
      vendored: sample.length,
      refusalHistogram: Object.fromEntries([...hist.entries()].sort((a, b) => b[1] - a[1])),
      note:
        'refusalHistogram counts EVERY reason a glyph was refused, so the columns sum to more ' +
        'than (candidates - scorable). See src/devtest/svgGround.ts for what each code means.',
      glyphs: all.map((v) => ({
        name: v.name, slug: v.slug, vendored: v.vendored,
        refusedColor: v.refusedColor, refusedFlat: v.refusedFlat,
        shapes: v.shapes, nodes: v.nodes, gradients: v.gradients,
      })),
    },
    null,
    2,
  ) + '\n',
)

// ---------------------------------------------------------------------------
// 4. Emit the corpus module
// ---------------------------------------------------------------------------

/**
 * The GATED subset. CI runtime is the constraint: a truth gate that takes ten minutes gets
 * turned off, and a gate that is off is not a gate. So a small, DETERMINISTIC slice is gated
 * and the rest is browse-only in the lab. Picked by hash order (already applied), so it is
 * stable as the corpus grows.
 */
const GATED = 10

const lines = sample.map((v, i) => {
  const flat = v.refusedFlat.length === 0
  return `  { name: 'fluent-${v.slug}', tier: 1, svg: 'public/corpus/fluent/color/${v.slug}.svg', ` +
    `flatSvg: ${flat ? `'public/corpus/fluent/flat/${v.slug}.svg'` : 'undefined'}, ` +
    `gradients: true, gated: ${i < GATED}, note: '${v.name.replace(/'/g, "\\'")} — ${v.gradients} gradients, ${v.shapes} shapes' },`
})

writeFileSync(
  join(root, 'src', 'devtest', 'fluentCorpus.ts'),
  `// GENERATED by src/devtest/vendorFluentEmoji.ts — do not edit by hand.
//
// Tier 1 of the ground-truth corpus: Microsoft Fluent Emoji "Color" (MIT), pinned at
// ${REPO}@${SHA}.
//
// These are the ${sample.length} glyphs that SURVIVED TRIAGE out of ${all.length} candidates. The other
// ${all.length - scorable.length} were refused by svgGround because their visible boundary is not the boundary their
// path data describes (strokes, filters, clips, masks) — scoring those would produce a
// confident number measured against geometry the renderer never drew. Full verdict for every
// candidate, including the refused ones: public/corpus/fluent/manifest.json.
//
// \`flatSvg\` is the SAME glyph's Flat variant — a separately authored, flat-colour drawing of
// the same subject. It is the control for the flat↔gradient A/B (src/devtest/fluentAbRun.ts):
// not a pixel-identical pair, but the same art with and without gradients, which is the
// comparison no public corpus has been able to offer.

import type { TruthCase } from './truthCorpus.ts'

export const FLUENT_CORPUS: TruthCase[] = [
${lines.join('\n')}
]
`,
)

console.log(`wrote src/devtest/fluentCorpus.ts (${sample.length} cases, ${Math.min(GATED, sample.length)} gated)`)
console.log(`wrote public/corpus/fluent/manifest.json (${all.length} verdicts)`)
