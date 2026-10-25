// The shape bench/compare/howItWorks.ts writes into howItWorks.generated.ts, declared by hand
// for the same reason as showcaseTypes.ts: the page type-checks against a contract.

import type { ShowExample, ShowPaired } from '../bench/showcaseTypes'

/** One tracer rule, shown with the rule switched off and on. */
export interface HowRule {
  /** The PlanarFitOptions key the ablation run switched off. */
  rule: string
  /** The metric the rule exists to move. */
  metric: string
  /** Off minus on, paired over the held-out cases (95% bootstrap interval), and how many
   *  cases the metric moved on at all. */
  census: (ShowPaired & { moved: number })[]
  /** Tools are 'off' and 'on'. */
  example: ShowExample
}

export interface HowPipeline {
  caseId: string
  width: number
  height: number
  regions: number
  edges: number
  vertices: number
  paths: number
  nodes: number
}

export interface HowItWorks {
  base: string
  date: string
  /** LogoLab's version string in the base run (the ablations are checked against it). */
  version: string
  res: number
  heldOutCases: number
  pipeline: HowPipeline
  rules: HowRule[]
}
