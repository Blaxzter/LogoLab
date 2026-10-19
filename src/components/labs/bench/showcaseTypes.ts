// The shape bench/compare/showcase.ts writes into showcase.generated.ts. Declared by hand so
// the page type-checks against a contract instead of against whatever literal was last
// generated (and so tsc does not infer a type from 36 KB of numbers).

export type ShowMetrics = Record<string, number | string | undefined>

export interface ShowTool {
  tool: string
  metrics: ShowMetrics
  /** Anchor points, flat [x, y, …], in the pixels of the `width`×`height` render. */
  anchors: number[]
  /** Counted tangent breaks, flat [x, y, kink°, …]. */
  breaks: number[]
  /** Per break, the unit tangents arriving and leaving: flat [itx, ity, otx, oty, …]. */
  dirs: number[]
}

export interface ShowExample {
  slug: string
  caseId: string
  license: string
  source: string
  width: number
  height: number
  authoredNodes: number[]
  tools: ShowTool[]
}

export interface ShowSummary {
  tool: string
  n: number
  failures: number
  regionsAll: number
  median: Record<string, number | null>
  /** Cases each metric was measured on. */
  scored: Record<string, number>
}

export interface ShowPaired {
  metric: string
  n?: number
  meanDiff?: number
  lo?: number
  hi?: number
  significant?: boolean
  wins?: number
  losses?: number
}

export interface Showcase {
  run: string
  date: string
  res: number
  corpus: string
  cases: number
  dataset: { id: string; revision: string; split: string; parquetSha256: string }
  versions: Record<string, string>
  summary: ShowSummary[]
  pairedVsVtracer: ShowPaired[]
  examples: ShowExample[]
}
