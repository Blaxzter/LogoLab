// The comparison's cases. Every one carries its AUTHORED SVG — the answer sheet — and says
// whether LogoLab was developed against it.
//
//   svgemoji-v0  HEADLINE. 100 Twemoji (CC-BY 4.0) from StarVector's SVG-Bench `svg-emoji`
//                TEST split, frozen by bench/compare/py/fetch_svgbench.py into
//                manifests/svg-emoji-test.json: fill-only, one per base emoji, ranked by sha1.
//                Held out — the tracer was never tuned on them.
//   svgemoji     the whole 668-row test split (Twemoji, OpenMoji, Noto) — the population the
//                paper's SVG-Emoji row is measured on. OpenMoji is stroked, so its geometry is
//                refused (gtRefusal) and only pixel metrics apply there.
//   truth0       the truth gate's tier 0 — handcrafted, one failure mode each. IN-SAMPLE.
//   fluent2      every 4th tier-2 Fluent flat twin (MIT), by name. IN-SAMPLE.
//
// A case whose ground truth svgGround refuses is KEPT: pixel metrics still apply, and the
// row says why geometry is n/a. Dropping it would quietly select the corpus by scorability.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tierCases } from '../truthCorpus.ts'
import { DATASETS, REPO } from './paths.ts'
import type { CompareCase, CorpusId } from './types.ts'

export const CORPORA: CorpusId[] = ['svgemoji-v0', 'svgemoji', 'truth0', 'fluent2']
export const DEFAULT_CORPORA: CorpusId[] = ['svgemoji-v0', 'truth0', 'fluent2']

interface ManifestRow {
  file: string
  source: string
  license: string
  sha256: string
  v0: boolean
}

function svgEmoji(v0Only: boolean): CompareCase[] {
  const manifest = join(REPO, 'bench', 'compare', 'manifests', 'svg-emoji-test.json')
  const dir = join(DATASETS, 'svg-emoji', 'test')
  if (!existsSync(dir)) {
    console.warn(
      `  svg-emoji not fetched — run: .bench-tools/starvector-venv/Scripts/python.exe -I bench/compare/py/fetch_svgbench.py`,
    )
    return []
  }
  const rows: ManifestRow[] = JSON.parse(readFileSync(manifest, 'utf8')).rows
  const corpus: CorpusId = v0Only ? 'svgemoji-v0' : 'svgemoji'
  return rows
    .filter((r) => !v0Only || r.v0)
    .map((r) => {
      const svgPath = join(dir, r.file)
      const name = r.file.replace(/\.svg$/, '')
      // The scored file must be the manifest's bytes — a re-fetch after an upstream change
      // (or a CRLF rewrite) must stop the run, not silently swap the held-out cases.
      if (!existsSync(svgPath)) throw new Error(`svg-emoji: ${r.file} missing — re-run fetch_svgbench.py`)
      const bytes = readFileSync(svgPath)
      const got = createHash('sha256').update(bytes).digest('hex')
      if (got !== r.sha256)
        throw new Error(
          `svg-emoji: ${r.file} sha256 ${got.slice(0, 12)} ≠ manifest ${r.sha256.slice(0, 12)} — refusing`,
        )
      const gradients = /Gradient/.test(bytes.toString('utf8'))
      return {
        id: `${corpus}/${name}`,
        corpus,
        name,
        svgPath,
        gradients,
        // Tier only picks which LANE conventions apply (paint gate on gradient tier 0). The
        // comparison's gate LIMITS are tool-neutral (score.ts: TRUTH_TOL for every case).
        tier: gradients ? 1 : 2,
        heldOut: true,
        license: r.license,
        source: `starvector/svg-emoji test (${r.source}) sha256:${r.sha256.slice(0, 12)}`,
      }
    })
}

export function loadCorpus(id: CorpusId): CompareCase[] {
  switch (id) {
    case 'svgemoji-v0':
      return svgEmoji(true)
    case 'svgemoji':
      return svgEmoji(false)
    case 'truth0':
      return tierCases(0).map((c) => ({
        id: `truth0/${c.name}`,
        corpus: id,
        name: c.name,
        svgPath: join(REPO, c.svg),
        gradients: c.gradients,
        tier: 0,
        inkFamilies: c.inkFamilies,
        heldOut: false,
        license: 'LogoLab fixture',
        source: c.svg,
      }))
    case 'fluent2':
      return tierCases(2)
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .filter((_, i) => i % 4 === 0)
        .map((c) => ({
          id: `fluent2/${c.name}`,
          corpus: id,
          name: c.name,
          svgPath: join(REPO, c.svg),
          gradients: false,
          tier: 2,
          inkFamilies: c.inkFamilies,
          heldOut: false,
          license: 'MIT (microsoft/fluentui-emoji)',
          source: c.svg,
        }))
  }
}

/**
 * One ink on white paper? Then the case runs in the MONO lane too (Potrace). Read off the
 * truth raster's flat interiors (8-neighbour-identical pixels), like scoreRegions: at most
 * two colours over 0.2% of the area, one of them white, the other dark and grey.
 */
export function laneOf(img: { width: number; height: number; data: Uint8ClampedArray }): 'colour' | 'mono' {
  return inkOf(img).lane
}

/** laneOf, plus the case's ink: the one dark flat colour on a mono case (`#rrggbb`) — what
 *  the mono-lane Potrace output is repainted in, as LogoLab's mono output is repainted in
 *  its probed ink. On a colour case it is the most common non-white flat colour (reported
 *  only; `potrace-bin` stays black, as SVG-Bench scores Potrace). */
export function inkOf(img: { width: number; height: number; data: Uint8ClampedArray }): {
  lane: 'colour' | 'mono'
  ink: string
} {
  const { width: w, height: h, data } = img
  const hist = new Map<number, number>()
  const at = (i: number): number => (data[i * 4] << 16) | (data[i * 4 + 1] << 8) | data[i * 4 + 2]
  for (let y = 1; y < h - 1; y += 2) {
    for (let x = 1; x < w - 1; x += 2) {
      const i = y * w + x
      const k = at(i)
      if (at(i - 1) !== k || at(i + 1) !== k || at(i - w) !== k || at(i + w) !== k) continue
      hist.set(k, (hist.get(k) ?? 0) + 1)
    }
  }
  const floor = Math.max(4, (w * h) / 4 / 500)
  const inks = [...hist.entries()].filter(([, n]) => n >= floor).map(([k]) => k)
  const rgb = (k: number) => [(k >> 16) & 255, (k >> 8) & 255, k & 255]
  const white = (k: number) => rgb(k).every((v) => v >= 245)
  const darkGrey = (k: number) => {
    const [r, g, b] = rgb(k)
    return Math.max(r, g, b) - Math.min(r, g, b) <= 24 && 0.299 * r + 0.587 * g + 0.114 * b < 128
  }
  const others = inks.filter((k) => !white(k))
  const lane = inks.length <= 2 && others.length === 1 && darkGrey(others[0]) ? 'mono' : 'colour'
  const top = [...hist.entries()].filter(([k]) => !white(k)).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0
  const k = lane === 'mono' ? others[0] : top
  return { lane, ink: `#${k.toString(16).padStart(6, '0')}` }
}
