// The Workbench: ONE analysis, over a switchable corpus.
//
// The corpus selector changes WHICH IMAGES, never what you are looking at. Every case is an
// authored SVG scored against itself (rasterize → trace → compare to the art that made the
// pixels), because that is the one question worth a whole view: "is the trace correct?".
//
// This is deliberately NOT a corpus × lens matrix. That shape existed briefly and was confusing:
// the available comparisons mutated when you switched corpus, so the view's meaning changed under
// you. Anything that cannot be asked of every corpus lives in its own lab instead — potrace vs
// crisp in the Engine scoreboard, raster-only art in the Gallery, variants in Feature A/B.
//
// The load-bearing rule is unchanged: nothing here re-implements scoring. The cases, the metrics
// and the gates come from the same devtest modules the Node CLI imports (truthCorpus, geomScore,
// svgGround); a corpus only PRODUCES cases, and this view only DRAWS what those modules return.

import type { FC, ReactNode } from 'react'

/** The authored SVG behind one case, resolved. */
export interface CaseSource {
  /** The markup — rasterized with resvg and parsed for ground truth. */
  svgText: string
  /** A URL for the "truth" panel to display (an http path, or a data: URL for inline art). */
  displayUrl: string
}

/** One case: an authored SVG we rasterize, trace, and score against itself. */
export interface WbCase {
  key: string
  title: string
  note?: ReactNode
  /**
   * The CALIBRATED tier (TIER_TOL) this case is held to. Gates render only when this is set:
   * a tier is a measured population, and a case outside one (a brand logo) has no honest
   * pass/fail — it gets the geometry numbers and no bars.
   */
  tier?: 0 | 1 | 2
  /** Trace with gradient fitting on? (Flat art is scored with it off.) */
  gradients: boolean
  /** The same glyph authored FLAT — the tier-1 A/B control. Repo-relative path. */
  flatSvg?: string
  /** Resolve the authored SVG. Fetched for served corpora, inline for bundled ones. */
  load(): Promise<CaseSource>
}

/** The whole Workbench's persisted view state. */
export interface WbUi {
  box: number
  page: number
  pageSize: number
  res: number
  heat: number
  ab: boolean
  /** Reveal the nodes wireframe baked into the truth + current-trace panels (pure CSS, no re-trace). */
  wire: boolean
}

export const DEFAULT_WB_UI: WbUi = {
  box: 260,
  page: 0,
  pageSize: 8,
  res: 512,
  heat: 5,
  ab: false,
  wire: false,
}

export type SetUi = (patch: Partial<WbUi>) => void

/**
 * A source of cases. It declares no capabilities and offers no options: every corpus here is
 * authored SVG, and every corpus gets the same analysis. Paging is the Workbench's job, so a
 * corpus just hands over its full list.
 */
export interface CorpusSource {
  id: string
  label: string
  /** False when the corpus can't run here (the Logo corpus in a clean/CI build). */
  available: boolean
  /** One line for the about panel. */
  blurb: string
  /** Every case, in display order. The Workbench pages it. */
  cases(): WbCase[]
  /** Shown instead of rows when `available` is false. */
  emptyState?: ReactNode
  /** True when this corpus has tier-1 flat twins, i.e. the flat A/B toggle does something. */
  hasFlatTwins?: boolean
}

export interface AnalysisRowProps {
  c: WbCase
  value: unknown
  error?: string
  ui: WbUi
}

export type AnalysisRow = FC<AnalysisRowProps>
