// Where /labs/bench reads a run from — pure, so the URL rules a test checks are the ones the
// page uses (node strips types from .ts, not .tsx).
//
// Two sources, one layout:
//
//   local  `vite dev` only: scripts/benchPlugin.ts serves the gitignored .bench-tools/results/
//          under /__bench. Every run there has its PNG renders.
//   hub    the hosted site: the published Hugging Face DATASET Blaxzter/logolab-bench, written by
//          bench/compare/publishHf.ts. Same `<run>/cases/<corpus>/<case>/<tool>.svg` layout,
//          but SVGs only — no PNG renders (the browser draws the SVG) — and the authored
//          answer sheet staged as `truth.svg` next to them, since the dataset cannot resolve a
//          case id to a path in someone's dataset cache the way the dev plugin does.
//
// The components ask for a run file by the LOCAL path (`gt/<case id>`, `<dir>/<tool>.png`,
// `manifests/<file>`) and `sourceUrl` maps it, so a tab has no idea which source it is on.
// A run without renders (`RunInfo.renders === false`, which publishHf writes into runs.json)
// gets the SVG wherever a PNG was asked for: `truth.png` becomes the staged `truth.svg`.
//
// Nothing here is bundled data: the hub is fetched at runtime, and the dev endpoint does not
// exist in a build. The page falls back to "this tab reads a local run" when neither answers.

export const HUB_REPO = 'Blaxzter/logolab-bench'
export const HUB_BASE = `https://huggingface.co/datasets/${HUB_REPO}/resolve/main/`
/** The dataset's page, for links (the viewer, the card). */
export const HUB_PAGE = `https://huggingface.co/datasets/${HUB_REPO}`

export type BenchSourceKind = 'local' | 'hub'

export interface BenchSource {
  kind: BenchSourceKind
  /** The run index: `{ runs: RunInfo[] }`, newest first. */
  runsUrl: string
  /** A file inside a run directory, by its path relative to the run. */
  file(run: string, path: string): string
  /** The case's AUTHORED SVG. */
  gt(run: string, caseId: string): string
  /** A corpus manifest (`svg-emoji-test.json`, …). */
  manifest(run: string, name: string): string
}

/** Each path segment encoded, the slashes kept. */
export const encodePath = (path: string): string => path.split('/').map(encodeURIComponent).join('/')

export const LOCAL_SOURCE: BenchSource = {
  kind: 'local',
  runsUrl: '/__bench/runs',
  file: (run, path) => `/__bench/runs/${encodeURIComponent(run)}/${encodePath(path)}`,
  // The plugin resolves the id through the run's pairs.jsonl; the id's slash is part of it.
  gt: (run, caseId) => `/__bench/runs/${encodeURIComponent(run)}/gt/${encodePath(caseId)}`,
  // The plugin serves the one manifest the Data tab reads, from bench/compare/manifests/.
  manifest: () => '/__bench/manifest',
}

export function hubSource(base = HUB_BASE): BenchSource {
  const b = base.endsWith('/') ? base : `${base}/`
  return {
    kind: 'hub',
    runsUrl: `${b}runs.json`,
    file: (run, path) => `${b}${encodeURIComponent(run)}/${encodePath(path)}`,
    gt: (run, caseId) => `${b}${encodeURIComponent(run)}/cases/${encodePath(caseId)}/truth.svg`,
    manifest: (run, name) => `${b}${encodeURIComponent(run)}/manifests/${encodeURIComponent(name)}`,
  }
}

export const HUB_SOURCE = hubSource()

/**
 * A run file's URL on `source`, from the path a tab asks for:
 *
 *   gt/<case id>             the authored SVG
 *   manifests/<name>         a corpus manifest
 *   …/<x>.png                the render, or `<x>.svg` when the run has none (`renders` false)
 *   anything else            the file itself
 */
export function sourceUrl(source: BenchSource, run: string, path: string, renders = true): string {
  if (path.startsWith('gt/')) return source.gt(run, path.slice(3))
  if (path.startsWith('manifests/')) return source.manifest(run, path.slice('manifests/'.length))
  if (!renders && path.endsWith('.png')) {
    // truth.png on a run without renders is the staged answer sheet, which is also what
    // `gt/` points at; every tool's PNG is its SVG.
    return source.file(run, `${path.slice(0, -4)}.svg`)
  }
  return source.file(run, path)
}

/** Is this URL an SVG (drawn by the browser) rather than a PNG render? */
export const isSvgUrl = (url: string): boolean => /\.svg(?:$|[?#])/i.test(url)

/**
 * The size an SVG is rasterized at when it stands in for a render: the run's raster box on
 * the long side, the drawing's own aspect (width ÷ height) on the other. The PNG renders were
 * made at the run's `res` the same way, so the Difference picture compares like with like —
 * drawn by the browser instead of resvg, so its mean can differ from the scored ΔE in the
 * last digit.
 */
export function renderBox(res: number, aspect: number): { w: number; h: number } {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 1
  return a >= 1 ? { w: res, h: Math.max(1, Math.round(res / a)) } : { w: Math.max(1, Math.round(res * a)), h: res }
}

/** Index entry as publishHf writes it (a superset of the dev plugin's RunInfo). */
export interface RunIndexEntry {
  name: string
  date: string | null
  corpora: string[]
  tools: string[]
  rows: number
  bytes: number
  /** false: the run ships SVGs only. Absent = renders present (every local run). */
  renders?: boolean
}

/** Read a run index, local or hub, defensively: a malformed entry is dropped, not a crash. */
export function parseRunIndex(json: unknown): RunIndexEntry[] {
  const list = (json as { runs?: unknown } | null)?.runs
  if (!Array.isArray(list)) return []
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  const out: RunIndexEntry[] = []
  for (const e of list as Record<string, unknown>[]) {
    if (!e || typeof e.name !== 'string' || !e.name) continue
    out.push({
      name: e.name,
      date: typeof e.date === 'string' ? e.date : null,
      corpora: strings(e.corpora),
      tools: strings(e.tools),
      rows: typeof e.rows === 'number' ? e.rows : 0,
      bytes: typeof e.bytes === 'number' ? e.bytes : 0,
      ...(e.renders === false ? { renders: false } : {}),
    })
  }
  return out
}
