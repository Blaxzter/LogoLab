// The Hugging Face dataset (Blaxzter/logolab-bench) a comparison run is published as — the
// pure half of bench/compare/publishHf.ts, so what a test checks is what gets uploaded.
//
// The dataset is the benchmark's public record: one directory per run, a dataset card
// (README.md) written from the newest run, and runs.json, the index /labs/bench reads. Three
// rules here are the point of the file:
//
//   • ALLOWLIST, not a denylist. A corpus is published only if it is named in PUBLISHABLE
//     with the licences its cases may carry. Anything else stops the publish — the private
//     logo corpus (examples/logos/, brand marks we may look at but not redistribute) first of
//     all, and equally a corpus added next month that nobody has checked yet. A case whose
//     licence string is not one its corpus allows stops it too: the per-case licence comes
//     from the run (meta.cases, written from the corpus manifest), not from this file.
//   • One flattened row per (tool, case) with ONE column set, so the Hub's viewer shows a
//     table and not a schema error. A column a row lacks is null; lists are joined; nothing
//     is renamed (the columns are ScoreRow's, as in results.json).
//   • The card's numbers are computed by the functions summary.md uses (report.ts
//     leaderboardMarkdown → benchData.ts leaderboard), held-out corpora only, so the card,
//     the summary and the hosted page cannot tell three different stories.

import {
  RANK_METRICS,
  corpusInfo,
  corpusKind,
  headlineCorpora,
  leaderboard,
  toolInfo,
} from '../../src/components/labs/bench/benchData.ts'
import type { BenchResults, BenchRow } from '../../src/components/labs/bench/benchData.ts'
import type { RunIndexEntry } from '../../src/components/labs/bench/benchSource.ts'
import { NO_VALUE, leaderboardMarkdown, plainMarkdown, tableCell } from './report.ts'
import type { ScoreRow } from './types.ts'

export const HF_REPO = 'Blaxzter/logolab-bench'
export const HF_URL = `https://huggingface.co/datasets/${HF_REPO}`

export interface Publishable {
  /** Licence strings a case of this corpus may carry (meta.cases[].license), exactly. */
  licences: RegExp
  /** Where it comes from, for the card. */
  source: string
  /** How the cases were picked, when corpusInfo has no blurb for it. */
  sampling: string
  /** The corpus manifest in bench/compare/manifests/, staged under <run>/manifests/. */
  manifest?: string
  /** Rasters of other people's TRADEMARKS (a licence on the file is not a trademark licence). */
  trademarks?: boolean
  /** Share-alike: renders and traces derived from it stay under the same licence. */
  shareAlike?: RegExp
}

/**
 * The corpora that may be published, and nothing else. Each licence permits redistribution
 * of modified versions with attribution (CC-BY / CC-BY-SA / Apache / MIT / ISC) or without
 * conditions (CC0); the fixtures are this repo's own, under its MIT licence.
 */
export const PUBLISHABLE: Record<string, Publishable> = {
  'svgemoji-v0': {
    licences: /^CC-BY-4\.0$/,
    source: 'starvector/svg-emoji test split (Hugging Face), Twemoji rows',
    sampling: '100 Twemoji, fill-only, one per base emoji, ranked by sha1(file) (fetch_svgbench.py).',
    manifest: 'svg-emoji-test.json',
  },
  svgemoji: {
    licences: /^(CC-BY-4\.0|CC-BY-SA-4\.0|Apache-2\.0)$/,
    source: 'starvector/svg-emoji test split (Hugging Face): Twemoji, OpenMoji, Noto Emoji',
    sampling: 'All 668 rows of the test split.',
    manifest: 'svg-emoji-test.json',
    shareAlike: /^CC-BY-SA-4\.0$/,
  },
  truth0: {
    licences: /^LogoLab fixture$/,
    source: 'LogoLab truth-gate tier 0 fixtures (bench/truthCorpus.ts)',
    sampling: 'Every tier-0 fixture: handcrafted, one failure mode each.',
  },
  fluent2: {
    licences: /^MIT \(microsoft\/fluentui-emoji\)$/,
    source: 'Microsoft Fluent UI Emoji, flat style (vendored in the LogoLab repo)',
    sampling: 'Every 4th tier-2 case by name.',
  },
  'logos-cc0': {
    licences: /^CC0-1\.0$/,
    source: 'gilbarbara/logos (CC0-1.0), pinned commit',
    sampling:
      '300 files, stratified by paint count, gradients and symbol/wordmark, ranked by sha1(file name) within a stratum (logosCc0.ts); the manifest records every exclusion and why.',
    manifest: 'logos-cc0.json',
    trademarks: true,
  },
  'strokes-oss': {
    // The exact strings strokesOss.ts writes per set, not a loose /^MIT/: an allowlist.
    licences: /^(ISC \(Lucide; portions MIT, Feather\)|MIT \(Tabler Icons\)|MIT \(Feather\)|MIT \(Phosphor Icons\))$/,
    // Phosphor is fetched and checked, then dropped (it ships no strokes): not a source here.
    source: 'Lucide, Tabler (outline) and Feather icon sets, pinned npm releases',
    sampling:
      'Per set, ranked by sha1(<set>/<name>), the first 67 eligible icons (strokesOss.ts); in-sample Lucide drawings, duplicates and unreadable icons are excluded with their reason in the manifest.',
    manifest: 'strokes-oss.json',
  },
}

/** The allowlist entry of a corpus, or undefined. Own keys only: `PUBLISHABLE[c]` would let
 *  a corpus named `constructor` through on Object.prototype's. */
export const publishable = (corpus: string): Publishable | undefined =>
  Object.hasOwn(PUBLISHABLE, corpus) ? PUBLISHABLE[corpus] : undefined

/** Who holds what, by licence string, for the card's licence table. */
const LICENCE_NOTE: [RegExp, string][] = [
  [
    /^CC-BY-4\.0$/,
    'Twemoji, Copyright Twitter, Inc. and other contributors, [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/); maintained at https://github.com/jdecked/twemoji',
  ],
  [
    /^CC-BY-SA-4\.0$/,
    'OpenMoji, HfG Schwäbisch Gmünd, [CC-BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) (https://openmoji.org). Share-alike: the renders and traces derived from these rows are CC-BY-SA 4.0 too.',
  ],
  [/^Apache-2\.0$/, 'Noto Emoji, Google, [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0)'],
  [/^MIT \(microsoft/, 'Fluent UI Emoji, Microsoft, MIT (https://github.com/microsoft/fluentui-emoji)'],
  [/^LogoLab fixture$/, 'LogoLab fixtures, Frederic Abraham, MIT (the LogoLab repository licence)'],
  [
    /^CC0-1\.0$/,
    'gilbarbara/logos, [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/): no copyright conditions, but the marks remain their owners’ trademarks',
  ],
  [/^ISC/, 'Lucide, ISC (portions MIT, from Feather)'],
  [/^MIT \(Feather\)/, 'Feather, Cole Bemis, MIT'],
  [/^MIT \(Phosphor/, 'Phosphor Icons, MIT'],
  [/^MIT \(Tabler/, 'Tabler Icons, Paweł Kuna, MIT'],
]

export const licenceNote = (licence: string): string => LICENCE_NOTE.find(([re]) => re.test(licence))?.[1] ?? licence

/** The corpus a case id belongs to: everything before its first slash ('' when it has none,
 *  which publishProblems refuses — `slice(0, indexOf('/'))` would have cut the id's last
 *  character off and looked the stub up in the allowlist instead). */
export const corpusOf = (id: string): string => {
  const i = id.indexOf('/')
  return i > 0 ? id.slice(0, i) : ''
}

/** A case id becomes a staging path (`<run>/cases/<id>/…`): it must be `<corpus>/<name>`
 *  with plain segments, nothing that climbs out of the staging directory. */
export const safeCaseId = (id: string): boolean => corpusOf(id) !== '' && !/\\|^\/|(^|\/)\.\.?(\/|$)|\/$|:/.test(id)

/**
 * Why this run may NOT be published — empty when it may. Checked: every corpus the run
 * names, rows or cases mention is allowlisted; every case's licence is one its corpus allows;
 * no case points into the private logo corpus; every case id is a safe `<corpus>/<name>`; no
 * value holds an absolute local path (publicResults takes out the one a run records itself).
 */
export function publishProblems(data: BenchResults): string[] {
  const problems: string[] = []
  for (const id of new Set([...data.rows.map((r) => r.caseId), ...(data.meta.cases ?? []).map((c) => c.id)]))
    if (!safeCaseId(id)) problems.push(`case id "${id}" is not a plain <corpus>/<name> path`)
  const corpora = new Set<string>([
    ...(data.meta.corpora ?? []),
    ...data.rows.map((r) => r.corpus),
    ...(data.meta.cases ?? []).map((c) => corpusOf(c.id)),
  ])
  for (const c of corpora)
    if (c && !publishable(c)) problems.push(`corpus "${c}" is not on the publish allowlist (hfCard.ts PUBLISHABLE)`)
  const caseIds = new Set(data.rows.map((r) => r.caseId))
  const meta = new Map((data.meta.cases ?? []).map((c) => [c.id, c]))
  for (const id of caseIds) {
    const c = meta.get(id)
    const corpus = corpusOf(id)
    if (!c) {
      problems.push(`${id}: no meta.cases entry, so no licence on record`)
      continue
    }
    const allow = publishable(corpus)
    if (allow && !allow.licences.test(c.license))
      problems.push(`${id}: licence "${c.license}" is not one ${corpus} may carry`)
    if (/examples[\\/]logos[\\/]/.test(c.source ?? ''))
      problems.push(`${id}: comes from the private examples/logos/ corpus`)
  }
  for (const at of localPaths(data)) problems.push(`${at} holds a local path`)
  return problems
}

/** An absolute path on someone's machine, anywhere in a string. */
const LOCAL_PATH = /(?:^|[\s"'(=])(?:[A-Za-z]:[\\/]|\/(?:home|Users|mnt|tmp|var)\/)/

/** Where a value holds a local path, as `$.meta.…`. */
export function localPaths(v: unknown, at = '$'): string[] {
  if (typeof v === 'string') return LOCAL_PATH.test(v) ? [at] : []
  if (Array.isArray(v)) return v.flatMap((x, i) => localPaths(x, `${at}[${i}]`))
  if (v && typeof v === 'object') return Object.entries(v).flatMap(([k, x]) => localPaths(x, `${at}.${k}`))
  return []
}

/**
 * results.json as published: the run's file without `reportFrom`, which says where the StarVector
 * batch report lay on the machine that ran it. That report is not published, so the field could
 * only ever tell a reader a local path. Key order is kept, so nothing else in the file moves.
 */
export function publicResults(data: BenchResults): BenchResults {
  const provenance = data.meta.provenance
  const starvector = provenance?.starvector
  if (!provenance || !starvector || typeof starvector !== 'object') return data
  const { reportFrom: _, ...kept } = starvector as Record<string, unknown>
  return { ...data, meta: { ...data.meta, provenance: { ...provenance, starvector: kept } } }
}

/** A path inside the private logo corpus (or anywhere outside what may be staged)? */
export function isPrivatePath(path: string): boolean {
  return /(^|[\\/])examples[\\/]logos([\\/]|$)/.test(path)
}

// ---------------------------------------------------------------------------
// results.jsonl

export type FlatValue = string | number | boolean | null
export type FlatRow = Record<string, FlatValue>

/** Columns first in every row, in this order; the rest follow in first-seen order. */
const LEAD = ['run', 'tool', 'corpus', 'caseId', 'heldOut', 'status', 'lane', 'caseLicense', 'caseSource']

function flatValue(v: unknown): FlatValue {
  if (v === undefined || v === null) return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' || typeof v === 'boolean') return v
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v.join(',')
  return JSON.stringify(v)
}

/**
 * One row per (tool, case), every row with the same columns: the run name and the case's
 * licence and source joined in, lists joined with commas, a missing field null. A number
 * column never holds a string, so the viewer's schema inference has one answer per column.
 */
export function flattenRows(data: BenchResults, run: string): FlatRow[] {
  const meta = new Map((data.meta.cases ?? []).map((c) => [c.id, c]))
  const raw = data.rows.map((r) => {
    const c = meta.get(r.caseId)
    return { run, ...r, caseLicense: c?.license ?? null, caseSource: c?.source ?? null } as Record<string, unknown>
  })
  const cols: string[] = [...LEAD]
  for (const r of raw) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k)
  // A column whose values are numbers on some rows and something else on others would make
  // the viewer pick one type and fail the rest: stringify that column throughout.
  const mixed = new Set<string>()
  for (const k of cols) {
    const kinds = new Set(
      raw
        .map((r) => flatValue(r[k]))
        .filter((v) => v !== null)
        .map((v) => typeof v),
    )
    if (kinds.size > 1) mixed.add(k)
  }
  return raw.map((r) => {
    const out: FlatRow = {}
    for (const k of cols) {
      const v = flatValue(r[k])
      out[k] = mixed.has(k) && v !== null ? String(v) : v
    }
    return out
  })
}

export const toJsonl = (rows: FlatRow[]): string => rows.map((r) => JSON.stringify(r)).join('\n') + '\n'

// ---------------------------------------------------------------------------
// runs.json

export function runEntry(data: BenchResults, run: string, bytes: number): RunIndexEntry {
  return {
    name: run,
    date: data.meta.date ?? null,
    corpora: data.meta.corpora ?? [],
    tools: data.meta.tools ?? [],
    rows: data.rows.length,
    bytes,
    renders: false,
  }
}

/** The published index with this run in it (replacing an older publish of the same name),
 *  newest first. */
export function mergeRunIndex(existing: RunIndexEntry[], entry: RunIndexEntry): RunIndexEntry[] {
  return [...existing.filter((e) => e.name !== entry.name), entry].sort(
    (a, b) => (b.date ?? '').localeCompare(a.date ?? '') || a.name.localeCompare(b.name),
  )
}

// ---------------------------------------------------------------------------
// README.md, the dataset card

export function sizeCategory(n: number): string {
  if (n < 1000) return 'n<1K'
  if (n < 10000) return '1K<n<10K'
  if (n < 100000) return '10K<n<100K'
  return '100K<n<1M'
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

const digits = (v: number): string =>
  Number.isInteger(v)
    ? String(v)
    : Math.abs(v) >= 100
      ? v.toFixed(0)
      : Math.abs(v) >= 1
        ? v.toFixed(2)
        : Math.abs(v) >= 0.01
          ? v.toFixed(3)
          : v.toPrecision(2)

/**
 * Markdown tables whose rows disagree with their header on the number of cells. A renderer shows
 * such a table as one paragraph of pipes, and neither the Hub's metadata check nor a build sees it.
 */
export function brokenTables(md: string): string[] {
  const cells = (line: string) => (line.match(/(?<!\\)\|/g) ?? []).length - 1
  const problems: string[] = []
  let head = 0
  md.split('\n').forEach((line, i) => {
    if (!line.startsWith('|')) head = 0
    else if (!head) head = cells(line)
    else if (cells(line) !== head) problems.push(`line ${i + 1} has ${cells(line)} cells, its header ${head}`)
  })
  return problems
}

/** The raw values behind the ranks: per tool, the median of each ranked metric and its n. */
export function medianTable(rows: BenchRow[], corpus: string, tools: string[]): string[] {
  const metrics = RANK_METRICS[corpusKind(corpus)]
  const out: string[] = []
  out.push(
    `| tool | cases | ${metrics.map((m) => `${tableCell(m.label)} ${m.better === 'lower' ? '↓' : '↑'}`).join(' | ')} |`,
  )
  out.push(`|---|---|${metrics.map(() => '---').join('|')}|`)
  for (const tool of tools) {
    const mine = rows.filter((r) => r.corpus === corpus && r.tool === tool)
    const cells = metrics.map((m) => {
      const xs = mine
        .map((r) => r[m.key])
        .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
        .map((v) => (m.abs ? Math.abs(v) : v))
      const md = median(xs)
      return md === null ? NO_VALUE : `${digits(md)} (${xs.length})`
    })
    out.push(`| ${tool} | ${mine.length} | ${cells.join(' | ')} |`)
  }
  return out
}

/**
 * What a line corpus's table cannot say by itself, measured from the rows. A rank there is mostly
 * whether a tool's output has strokes at all, so a tool's place needs reading.
 */
export function lineCorpusNotes(rows: BenchRow[], corpus: string): string[] {
  const head = leaderboard(rows, { corpus, view: 'headline', resamples: 1 })
  const tools = head.tools.map((t) => t.tool)
  const of = (tool: string): BenchRow[] => rows.filter((r) => r.corpus === corpus && r.tool === tool)
  const nums = (mine: BenchRow[], key: string): number[] =>
    mine.map((r) => r[key]).filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  const out: string[] = []

  const sameOutput = (a: string, b: string): boolean => {
    const other = new Map(of(b).map((r) => [r.caseId, r]))
    const mine = of(a)
    return (
      mine.length > 0 &&
      mine.length === other.size &&
      mine.every((r) => {
        const o = other.get(r.caseId)
        return typeof r.bytes === 'number' && o?.bytes === r.bytes && o.meanDeltaE === r.meanDeltaE
      })
    )
  }
  const pairs = tools.flatMap((a, i) =>
    tools.slice(i + 1).flatMap((b) => (sameOutput(a, b) ? [`\`${a}\` and \`${b}\``] : [])),
  )
  if (pairs.length)
    out.push(
      `- These rows are one output and share a rank, with the same file size and ΔE on every case: ${pairs.join('; ')}.`,
    )

  const imagetracer = of('imagetracer-default')
  const centre = median(nums(imagetracer, 'clCentre'))
  const width = median(nums(imagetracer, 'clWidthErr'))
  if (centre !== null && width !== null)
    out.push(
      `- \`imagetracer-default\` does not find centrelines, and its place comes from that: it strokes every outline ` +
        `1 px in its own colour to hide seams, those strokes are scored as centrelines (median centre distance ` +
        `${digits(centre)} px, width error ${digits(width)}), and a tool with no strokes is tied last.`,
    )

  // A case is <corpus>/<set>-<icon>: the icon sets are drawn in one style, so a gap between them
  // is about the set, not the style.
  const setOf = (r: BenchRow): string => r.caseId.slice(r.caseId.indexOf('/') + 1).split('-')[0]
  const model = of('starvector-1b')
  const sets = [...new Set(model.map(setOf))].sort()
  if (sets.length > 1 && sets.includes('feather')) {
    const medians = (tool: string): string =>
      sets
        .map((s) =>
          digits(
            median(
              nums(
                of(tool).filter((r) => setOf(r) === s),
                'meanDeltaE',
              ),
            ) ?? Number.NaN,
          ),
        )
        .join(', ')
    const near = sets.map((s) => {
      const inSet = model.filter((r) => setOf(r) === s)
      return `${nums(inSet, 'meanDeltaE').filter((v) => v < 0.5).length} of ${inSet.length} ${s}`
    })
    const closest = model
      .filter((r) => setOf(r) === 'feather' && typeof r.clCentre === 'number')
      .sort((a, b) => (a.clCentre as number) - (b.clCentre as number))[0]
    const place = (b: typeof head): { mean: number; at: number } => {
      const at = b.tools.findIndex((t) => t.tool === 'starvector-1b')
      return { mean: b.tools[at]?.mean ?? Number.NaN, at: at + 1 }
    }
    const withIt = place(head)
    const without = place(
      leaderboard(
        rows.filter((r) => !(r.corpus === corpus && setOf(r) === 'feather')),
        { corpus, view: 'headline', resamples: 1 },
      ),
    )
    const controls = ['logolab-auto', 'omnisvg-4b']
      .filter((t) => of(t).length)
      .map((t) => `; \`${t}\` ${medians(t)}`)
      .join('')
    out.push(
      `- \`starvector-1b\` draws Feather back far closer than the other sets: ΔE is under 0.5 on ${near.join(', ')} ` +
        `icons (median ΔE ${medians('starvector-1b')}, in the order ${sets.join(', ')}${controls}).` +
        (closest
          ? ` Its closest centreline is ${(closest.clCentre as number).toFixed(2)} px off at this corpus's resolution ` +
            `(${closest.caseId}), from an input its processor resizes to 224 px.`
          : '') +
        ` That looks like recall of icons seen in training, though its training data was not checked. ` +
        `Without Feather its mean rank moves from ${withIt.mean.toFixed(2)} to ${without.mean.toFixed(2)} and its place ` +
        (withIt.at === without.at ? `stays ${withIt.at}.` : `from ${withIt.at} to ${without.at}.`),
    )
  }
  return out
}

/** The fetch step of a corpus that has one besides svg-emoji (the Reproduce block). */
const FETCH: [string, string][] = [
  ['logos-cc0', 'node --experimental-strip-types bench/compare/fetchLogos.ts        # gilbarbara/logos, pinned'],
  ['strokes-oss', 'node --experimental-strip-types bench/compare/fetchStrokesOss.ts   # stroke icon sets, pinned'],
]

export interface CardInput {
  data: BenchResults
  run: string
  /** The index after this publish, newest first: every run gets a viewer config. */
  index: RunIndexEntry[]
  /** Staged files of this run, for the "what is in it" counts. */
  counts: { svgs: number; truths: number; overlays: number; bytes: number }
}

const yamlStr = (s: string): string => JSON.stringify(s)

export function cardMarkdown({ data, run, index, counts }: CardInput): string {
  const m = data.meta
  const rows = data.rows as BenchRow[]
  const out: string[] = []
  const runs = index.length ? index : [runEntry(data, run, 0)]
  const totalRows = runs.reduce((s, r) => s + r.rows, 0)
  const corpora = m.corpora ?? []
  const hasLine = corpora.some((c) => corpusKind(c) === 'line')
  const hasLogos = corpora.some((c) => publishable(c)?.trademarks)

  // ── front matter ────────────────────────────────────────────────────────────
  out.push('---')
  out.push('license: other')
  out.push('license_name: per-source')
  // The Hub takes a file only under the exact name LICENSE or LICENSE.md; anything else must be a URL.
  out.push(`license_link: ${HF_URL}/blob/main/LICENSES.md`)
  out.push(`pretty_name: ${yamlStr('LogoLab vectorizer benchmark')}`)
  out.push('language:', '- en')
  out.push('task_categories:', '- image-to-text')
  out.push(
    'tags:',
    ...[
      'svg',
      'vectorization',
      'image-vectorization',
      'raster-to-vector',
      'benchmark',
      'icons',
      'emoji',
      ...(hasLine ? ['line-art'] : []),
      ...(hasLogos ? ['logos'] : []),
    ].map((t) => `- ${t}`),
  )
  out.push('size_categories:', `- ${sizeCategory(totalRows)}`)
  out.push('configs:')
  runs.forEach((r, i) => {
    out.push(`- config_name: ${yamlStr(r.name)}`)
    out.push('  data_files:')
    out.push('  - split: test')
    out.push(`    path: ${yamlStr(`${r.name}/results.jsonl`)}`)
    if (i === 0) out.push('  default: true')
  })
  out.push('---')
  out.push('')

  // ── what this is ────────────────────────────────────────────────────────────
  out.push('# LogoLab vectorizer benchmark')
  out.push('')
  out.push(
    'Raster-to-SVG tracers and image-to-SVG models, run on rasters of authored SVGs and scored against those SVGs. ' +
      'Each run directory holds every tool’s SVG for every case, the authored SVG it was rendered from, and one scored ' +
      'row per (tool, case). The benchmark code is [bench/compare/](https://github.com/Blaxzter/LogoLab/tree/main/bench/compare) ' +
      'in the LogoLab repository; the results are browsable at https://logolab.fabraham.dev/labs/bench, which reads this dataset.',
  )
  out.push('')
  out.push(
    `This card describes run ${run} (${m.date?.slice(0, 10) ?? 'undated'}, LogoLab ${m.logolab}, scored at ${m.res}px). ` +
      `The dataset viewer's default config is ${runs[0].name}; every published run has its own config.`,
  )
  out.push('')
  out.push(
    'LogoLab is one of the tools under test, and the geometry metrics are LogoLab’s own truth-gate metrics. ' +
      'Read the numbers with that in mind; the SVG-Bench columns (StarVector’s released metric code) are there so the ' +
      'results can be checked against a metric LogoLab did not design.',
  )
  out.push('')

  // ── what is measured ────────────────────────────────────────────────────────
  out.push('## What is measured, and how')
  out.push('')
  out.push(
    `- Every tool is given the same PNG of each case: the authored SVG rendered on white at ${m.res}px with resvg. ` +
      'Whatever SVG it returns is written to disk and scored by the same code (bench/compare/score.ts), LogoLab’s included.',
  )
  out.push(
    '- Pixel metrics compare the output, rendered back at the same size, with the input raster: mean CIE76 ΔE (LogoLab’s ' +
      'shipped `deltaEField`) and SVG-Bench’s MSE, SSIM, LPIPS (VGG) and DINOv2 similarity.',
  )
  out.push(
    '- Geometry metrics compare the output with the authored SVG’s outlines: boundary chamfer distance and its p95, node ' +
      'count and parsimony, corners recovered and invented, tangent breaks (kinks on boundary the artist drew smooth) and ' +
      'regions recovered. Only the visible boundary counts, for every tool. Where the authored SVG cannot be read as filled ' +
      'regions (strokes, clips), the case keeps its pixel metrics and the row says why geometry is missing (`gtRefusal`).',
  )
  if (hasLine)
    out.push(
      '- Centreline metrics apply to the line corpora, whose authored SVGs are strokes: the authored `d` is the centreline ' +
        'and `stroke-width` the width a tool has to find (bench/lineArtGround.ts reads both, bench/centerlineScore.ts ' +
        'scores them). The columns are `clCentre` / `clCentreP95` (distance from the traced centreline to the authored one, mean and ' +
        'p95 px), `clMissed` (mean distance of the authored samples no traced line covers), `clWidthErr` (relative width ' +
        'error), `clEndsDelta` / `clPathsDelta` (ends and paths, traced minus authored), `clTurns` (traced paths that ' +
        'leave one authored stroke for another). An outline tracer’s output has no stroke, so its row has none of them ' +
        '(`geomRefusal` "no strokes") and is tied last on them, like any tool with no value.',
    )
  out.push(
    '- A tool that returns no output, or output resvg cannot draw, is scored as a blank white image and kept in every ' +
      'count (`status` ≠ `ok`). No row is dropped.',
  )
  out.push(
    '- LogoLab was developed against the in-sample corpora (`heldOut: false`). They are ' +
      'published as data, but no leaderboard is computed on them.',
  )
  out.push('')

  // ── leaderboard ─────────────────────────────────────────────────────────────
  const board = leaderboardMarkdown(data.rows as unknown as ScoreRow[])
  if (board.length) {
    out.push(...board)
    out.push('### Raw medians behind the ranks')
    out.push('')
    out.push(
      'Median of each ranked metric over the cases where the tool has a value (n in brackets), headline tools only.',
    )
    out.push('')
    for (const corpus of headlineCorpora(rows)) {
      const head = leaderboard(rows, { corpus, view: 'headline', resamples: 1 })
      out.push(`#### ${corpus}`)
      out.push('')
      out.push(
        ...medianTable(
          rows,
          corpus,
          head.tools.map((t) => t.tool),
        ),
      )
      out.push('')
    }
    for (const corpus of headlineCorpora(rows).filter((c) => corpusKind(c) === 'line')) {
      const notes = lineCorpusNotes(rows, corpus)
      if (notes.length) out.push(`### Reading the ${corpus} table`, '', ...notes, '')
    }
  } else {
    out.push('## Leaderboard', '', 'This run has no held-out corpus, so no leaderboard is computed.', '')
  }

  // ── corpora ─────────────────────────────────────────────────────────────────
  out.push('## Corpora')
  out.push('')
  out.push('| corpus | held out | cases | licence(s) | source | how sampled |')
  out.push('|---|---|---|---|---|---|')
  const byCorpus = new Map<string, Map<string, number>>()
  for (const c of m.cases ?? []) {
    const corpus = corpusOf(c.id)
    let lic = byCorpus.get(corpus)
    if (!lic) byCorpus.set(corpus, (lic = new Map()))
    lic.set(c.license, (lic.get(c.license) ?? 0) + 1)
  }
  for (const corpus of m.corpora ?? []) {
    const info = corpusInfo(corpus)
    const pub = publishable(corpus)
    const lic = byCorpus.get(corpus) ?? new Map<string, number>()
    const n = [...lic.values()].reduce((a, b) => a + b, 0)
    const held = rows.find((r) => r.corpus === corpus)?.heldOut ?? info.heldOut
    out.push(
      `| ${corpus} | ${held ? 'yes' : 'no (in-sample)'} | ${n} | ${[...lic.entries()].map(([l, k]) => `${l} (${k})`).join(', ')} | ` +
        `${pub?.source ?? info.source} | ${(info.blurb || pub?.sampling || '').replace(/\|/g, '\\|')} |`,
    )
  }
  out.push('')
  out.push(
    'A fetched corpus (svg-emoji, and any other with a manifest) is checked against the sha256 its manifest records ' +
      'before a run traces it; the manifests are in `<run>/manifests/`. The in-repo fixtures (truth0, fluent2) are ' +
      'staged from the run’s LogoLab commit. `manifests/cases.json` lists each case’s licence, source and the sha256 ' +
      'of the staged `truth.svg`.',
  )
  out.push('')

  // ── tools ───────────────────────────────────────────────────────────────────
  out.push('## Tools and settings')
  out.push('')
  out.push('| row | version as run | what it was given |')
  out.push('|---|---|---|')
  for (const t of m.tools ?? []) {
    const ran = rows.some((r) => r.tool === t)
    if (!ran) continue
    out.push(
      `| ${t} | ${(m.versions?.[t] ?? NO_VALUE).replace(/\|/g, '\\|')} | ${toolInfo(t).blurb.replace(/\|/g, '\\|') || NO_VALUE} |`,
    )
  }
  out.push('')
  out.push(
    'The generation settings of the two models (StarVector, OmniSVG), the exact commit of every tool and the tree the run ' +
      'was made from are in `meta.provenance` of `<run>/results.json`. `ms` is wall time and is not comparable across tools ' +
      '(in-process for LogoLab, process spawn for the CLI tracers, GPU generation for the models).',
  )
  out.push('')

  // ── files ───────────────────────────────────────────────────────────────────
  out.push('## Files')
  out.push('')
  out.push('```')
  out.push('README.md                 this card (written from the newest run)')
  out.push('LICENSES.md               the per-source licence table and the MIT / ISC licence texts')
  out.push('runs.json                 index of published runs, newest first (what /labs/bench reads)')
  out.push(`${run}/results.jsonl          one flattened row per (tool, case): the viewer's table`)
  out.push(`${run}/results.json           the run: meta (versions, provenance, cases) + rows`)
  out.push(`${run}/summary.md             the run's full report (medians, paired bootstrap, SVG-Bench, gates)`)
  out.push(`${run}/ATTRIBUTION.md         attribution for each source`)
  out.push(`${run}/manifests/             corpus manifests + cases.json`)
  out.push(`${run}/cases/<corpus>/<case>/truth.svg      the authored SVG (the answer sheet)`)
  out.push(`${run}/cases/<corpus>/<case>/<tool>.svg     each tool's output, as scored`)
  out.push(`${run}/cases/<corpus>/<case>/overlay.json   anchors and counted kinks per tool (the Nodes view)`)
  out.push('```')
  out.push('')
  out.push(
    `Run ${run}: ${data.rows.length} scored rows, ${counts.svgs} tool SVGs, ${counts.truths} authored SVGs, ` +
      `${counts.overlays} overlays, ${(counts.bytes / 1e6).toFixed(1)} MB. No PNG renders are published: the renders are ` +
      'reproducible from the SVGs (resvg, white background, the run’s resolution), and the browser draws the SVGs.',
  )
  out.push('')

  // ── reproduce ───────────────────────────────────────────────────────────────
  out.push('## Reproduce')
  out.push('')
  out.push('From a checkout of https://github.com/Blaxzter/LogoLab (Node ≥ 22, pnpm):')
  out.push('')
  out.push('```bash')
  out.push('pnpm install')
  out.push(
    'bash bench/compare/py/setup.sh          # VTracer, Potrace, AutoTrace, ImageTracer, model venvs, all pinned',
  )
  out.push(
    '.bench-tools/starvector-venv/Scripts/python.exe -I bench/compare/py/fetch_svgbench.py   # svg-emoji test split',
    ...FETCH.filter(([c]) => (m.corpora ?? []).includes(c)).map(([, cmd]) => cmd),
  )
  out.push(`node --experimental-strip-types bench/compare/run.ts --run my-run --corpus ${(m.corpora ?? []).join(',')}`)
  out.push('node --experimental-strip-types bench/compare/publishHf.ts --run my-run   # dry run: the staged file list')
  out.push('```')
  out.push('')
  out.push(
    `This run was made from LogoLab commit ${m.logolab}. The models need an NVIDIA GPU; ` +
      '`--skip-tools starvector-1b,omnisvg-4b` runs the rest on a CPU.',
  )
  out.push('')
  for (const { rev, benchChanged } of m.progressFrom ?? []) {
    out.push(
      `It reused traces and scores saved at ${rev} (\`meta.progressFrom\`). A run only accepts that while the tracer ` +
        `(\`src/\`) is the same at both commits. The benchmark files that differ: ` +
        `${benchChanged.map((f) => `\`${f}\``).join(', ') || 'none'}.`,
    )
    out.push('')
  }
  for (const [was, now] of Object.entries(m.renamed ?? {})) {
    out.push(
      `LogoLab commit ${m.logolab} still calls \`${now}\` \`${was}\`: the row was renamed after scoring ` +
        '(`meta.renamed`), and its numbers and traces are unchanged.',
    )
    out.push('')
  }

  // ── licences ────────────────────────────────────────────────────────────────
  const shareAlike = (m.cases ?? []).some((c) => {
    const re = publishable(corpusOf(c.id))?.shareAlike
    return !!re && re.test(c.license)
  })
  out.push('## Licences')
  out.push('')
  out.push(...licenceTable(data))
  out.push('')
  out.push(
    'Under `cases/`, each `truth.svg` is the source art as distributed, and each tool’s SVG is a modified version of ' +
      'it (rasterized and re-vectorized); both stay under the source’s licence, with its attribution. ' +
      (shareAlike
        ? 'This run includes CC-BY-SA 4.0 sources (OpenMoji): their traces and any renders of them are CC-BY-SA 4.0 too. '
        : 'CC-BY-SA sources (OpenMoji, in the full `svgemoji` corpus) keep that licence in their traces; this run has none. ') +
      'The benchmark code and this card are MIT (the LogoLab repository licence).',
  )
  out.push('')
  if (hasLogos) {
    out.push(
      '**Trademarks.** The logo corpora are brand marks. Their files are CC0 as distributed by their collection, but a ' +
        'copyright licence is not a trademark licence: the marks belong to their owners, are included only to measure ' +
        'tracing, and their presence implies no affiliation or endorsement.',
    )
    out.push('')
  }
  out.push(
    'LogoLab’s private logo corpus (the brand marks its studio is tested on) is never published: the publishing script ' +
      'refuses any corpus not on its allowlist.',
  )
  out.push('')

  // ── citation ────────────────────────────────────────────────────────────────
  out.push('## Citation')
  out.push('')
  out.push('```bibtex')
  out.push('@misc{logolab_bench,')
  out.push('  title        = {{LogoLab} vectorizer benchmark},')
  out.push('  author       = {Abraham, Frederic},')
  out.push(`  year         = {${(m.date ?? '').slice(0, 4) || '2026'}},`)
  out.push(`  howpublished = {\\url{${HF_URL}}},`)
  out.push(`  note         = {Run ${run}, LogoLab commit ${m.logolab}}`)
  out.push('}')
  out.push('```')
  out.push('')
  out.push(
    'The SVG-Bench metrics and the svg-emoji corpus are from StarVector (Rodriguez et al., “StarVector: Generating ' +
      'Scalable Vector Graphics Code from Images and Text”, CVPR 2025); the rank statistics follow ' +
      'Demšar, “Statistical Comparisons of Classifiers over Multiple Data Sets”, JMLR 7, 2006.',
  )
  out.push('')
  return plainMarkdown(out.join('\n'))
}

/** Per corpus × licence, how many cases, and who holds it. */
export function licenceTable(data: BenchResults): string[] {
  const out = ['| corpus | licence | cases | holder / notes |', '|---|---|---|---|']
  const counts = new Map<string, number>()
  for (const c of data.meta.cases ?? []) {
    const key = `${corpusOf(c.id)}\u0000${c.license}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  for (const [key, n] of counts) {
    const [corpus, licence] = key.split('\u0000')
    out.push(`| ${corpus} | ${licence} | ${n} | ${licenceNote(licence)} |`)
  }
  return out
}

/** A licence whose text has to travel with the copies: MIT and ISC both ask for it. CC0 asks
 *  for nothing, and CC-BY is met by the credit and the link in the table. */
const NEEDS_TEXT = /^(MIT|ISC)\b/

export interface LicenceText {
  /** The licence string on the cases it covers (meta.cases[].license). */
  licence: string
  title: string
  text: string
}

/** Licences this run's cases carry whose text is not in `texts`: publishHf.ts refuses on any. */
export function missingLicenceTexts(data: BenchResults, texts: LicenceText[]): string[] {
  const have = new Set(texts.map((t) => t.licence))
  return [...new Set((data.meta.cases ?? []).map((c) => c.license))].filter((l) => NEEDS_TEXT.test(l) && !have.has(l))
}

/** LICENSES.md, the front matter's `license_link`: the table, then each text verbatim. */
export function licensesMarkdown(data: BenchResults, texts: LicenceText[] = []): string {
  const head = plainMarkdown(
    [
      '# Licences',
      '',
      'This dataset mixes sources under different licences; each case carries its own (`caseLicense` in results.jsonl,',
      '`license` in results.json `meta.cases`). Derived files (renders, traces) keep their source’s licence and',
      'attribution; CC-BY-SA sources stay CC-BY-SA. The code, the metrics tables and the card are MIT.',
      '',
      ...licenceTable(data),
      '',
    ].join('\n'),
  )
  if (!texts.length) return head
  const body = texts.flatMap((t) => [`### ${t.title}`, '', '```text', t.text.trim(), '```', ''])
  return [head, '## Licence texts', '', ...body].join('\n')
}

/** ATTRIBUTION.md: true of a run directory (which has PNG renders) and of its published copy
 *  (which has only the SVGs). */
export function attributionMarkdown(logosCommit: string): string {
  return `# Attribution

Each truth.svg under cases/, every tool's SVG and any PNG render of them are derived from the
sources below. The manifests named here are under manifests/ in the published dataset and under
bench/compare/manifests/ in the LogoLab repository.

- svgemoji*: StarVector SVG-Bench \`starvector/svg-emoji\` test split (Hugging Face; the
  revision and parquet sha256 are in svg-emoji-test.json). Each row's licence is its emoji set's:
  - Twemoji: Copyright Twitter, Inc. and other contributors, CC-BY 4.0
    (https://creativecommons.org/licenses/by/4.0/). Maintained at https://github.com/jdecked/twemoji
    (twitter/twemoji is archived).
  - OpenMoji: HfG Schwäbisch Gmünd, CC-BY-SA 4.0 (https://openmoji.org).
  - Noto Emoji: Google, Apache-2.0 (https://github.com/googlefonts/noto-emoji).
- logos-cc0: gilbarbara/logos at commit ${logosCommit}
  (https://github.com/gilbarbara/logos/tree/${logosCommit}; per-file sha256 in logos-cc0.json),
  whose LICENSE.txt is CC0 1.0 Universal (https://creativecommons.org/publicdomain/zero/1.0/).
  CC0 covers the artwork only: the logos are trademarks of their respective owners, no endorsement
  is implied, and they are rendered and re-traced here solely to measure vectorizers.
- fluent2: Microsoft Fluent UI Emoji, MIT (https://github.com/microsoft/fluentui-emoji).
- truth0: LogoLab fixtures.
- strokes-oss: stroke icon sets at the versions pinned in strokes-oss.json (each row names its
  set, version, file and sha256):
  - Lucide (lucide-static 1.55.0): ISC License, Copyright (c) 2026 Lucide Icons and Contributors
    (https://github.com/lucide-icons/lucide). Lucide is a fork of Feather; the portions from
    Feather are MIT, Copyright (c) 2013-2023 Cole Bemis.
  - Tabler Icons (@tabler/icons 3.49.0, outline): MIT License, Copyright (c) 2020-2026 Paweł Kuna
    (https://github.com/tabler/tabler-icons).
  - Feather (feather-icons 4.29.2): MIT License, Copyright (c) 2013-2023 Cole Bemis
    (https://github.com/feathericons/feather).
  Some Feather icons depict third-party brand marks (e.g. github, linkedin); those marks belong
  to their owners.

The MIT and ISC licence texts are in LICENSES.md at the root of the published dataset, and each
icon set's text has its sha256 in strokes-oss.json.

Renders and traces here are modified (rasterized and re-vectorized) versions of those works.
`
}
