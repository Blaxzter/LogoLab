// Segmentation options, the Step-3c merge observer record, defaults and the result shape.

import type { QuantizeResult } from '../types'
import { DEFAULT_MS_OPTIONS, type MumfordShahOptions, type MumfordShahResult } from '../mumfordShah.ts'
import type { RegionSamples } from '../gradient.ts'
import type { GradientFill } from '../../path/types'

export interface SegmentOptions {
  ms: MumfordShahOptions
  /** CIELAB ΔE below which adjacent smooth segments merge (color-diff, τ_s). */
  tauS: number
  /** Discontinuity facing-scan radius (px), σ. */
  sigma: number
  /** Facing density above which a segment pair is must-stay-separate, τ_a. */
  tauA: number
  /** Min facing observations before a pair can enter 𝒜 (noise floor). */
  minFacing: number
  /** Oklab ΔE under which a single gradient is judged to explain a union. */
  mergeTol: number
  /** Reject a union whose colour profile has an empty axis span wider than this
   *  fraction of [0,1] (bimodal ⇒ two distinct flats, not one smooth field). */
  maxProfileGap: number
  /**
   * Reject a union whose fitted gradient makes an Oklab colour jump larger than
   * this across a sample-free stretch of its parameter t (an "unwitnessed jump").
   *
   * A multi-stop gradient can explain two disjoint flats almost perfectly as a
   * step function (flat, jump, flat), often with a lower residual than an honest
   * ramp merge, so without this veto the greedy merge fuses distinct objects into
   * one region wearing a step "gradient". A step's signature is that its whole
   * contrast sits at a point of t no sample explains: the samples on either side,
   * each extrapolated along its own colour trend in t, do not meet there. A
   * genuine smooth field's two sides do meet, and a genuine reunite overlaps in t.
   * The jump is measured between adjacent samples at sample resolution; binning t
   * would miss a step placed inside one bin.
   *
   * The veto fires only when one of the two groups is itself near-flat (see
   * FLAT_FLANK_RES): pieces of a smooth field may jump across a gap their own
   * trend explains, and blocking those only reorders the merge sequence, which
   * perturbs the strided samples and thus the fitted paint. Values ≥ 1.2 (the
   * Oklab ΔE ceiling) disable it.
   */
  maxUnwitnessedJump: number
  /**
   * Run Step 3c, the global gradient-explained union-fit merge, which fuses the
   * colour-difference bands of a smooth ramp back into one gradient region. With
   * gradients off that region would be flattened to its mean colour, so the merge
   * is skipped and the Step-2 bands posterize into several flat regions.
   * Default true. */
  mergeGradients: boolean
  /** Cap on samples per segment fed to a union fit (perf; deterministic stride). */
  sampleCap: number
  /**
   * Step-3c candidate gate, in Oklab ΔE. Bounds the O(S²) pair fits on complex
   * images. It engages only once the fine-segment count exceeds GATE_MIN_SEGMENTS
   * (small art stays ungated, keeping its non-adjacent reunites). When engaged, a
   * pair reaches the gradient fit only if the groups are adjacent or, when
   * meanGate > 0, their mean colours are within meanGate. The mean clause re-joins
   * non-adjacent same-mean pieces but is much slower on photos and tends to force
   * distant pieces into one stretched gradient, so it defaults off (0 ⇒
   * adjacency only). Only consulted when `mergeGradients` is on.
   */
  meanGate: number
  /**
   * Minimum macro-region area (opaque px). After segmentation, any region smaller
   * than this is absorbed into the adjacent region whose mean colour is closest,
   * so AA and colour-ramp transition slivers don't survive as tiny shapes.
   * 0 ⇒ disabled. Driven by the Despeckle setting.
   */
  minRegionArea: number
  /**
   * Flat region markers in normalized [0,1] coords (distinct from `markers`). Each
   * flat marker's pre-merge fine segment is excluded from the Step-3c gradient
   * merge, so it survives as its own region instead of being fused into a gradient
   * with its neighbours. The exclusion happens before the Step-4 anti-alias flood,
   * so the region's boundary settles on the true colour edge and a single marker
   * suffices. Painted solid downstream (index.ts). Processed in input order.
   */
  flatMarkers?: { x: number; y: number }[]
  /**
   * User-placed region markers in normalized [0,1] image coordinates (converted
   * to pixels against the image's own size, so they hold at any resolution). Each
   * marker seeds a distinct region: two segments carrying different markers never
   * merge (vetoed in both merge steps), and a marked segment is never absorbed.
   * Processed in input order so the veto is deterministic.
   */
  markers?: { x: number; y: number }[]
  /**
   * Diagnostic observer for the Step-3c merge. Called once per pair evaluation that
   * ran (a cache miss in evalPair) with all four terms of the acceptance condition,
   * computed in full even where the condition short-circuits so the caller can see
   * which term decided, and once per accepted merge, in merge order. Read-only: the
   * result is identical with or without an observer. Used by
   * `bench/stepRampDiag.ts`.
   */
  onPair?: MergePairObserver
}

/**
 * One Step-3c event for `SegmentOptions.onPair`: a pair evaluation (`kind: 'eval'`,
 * every cache-miss call of evalPair, whether or not it reached the fit) or an accepted
 * merge (`kind: 'merged'`, the global-min pair of one sweep, fused into group `c`).
 */
export interface MergePairRecord {
  kind: 'eval' | 'merged'
  /** Group ids — stable, never reused; ≥ S for a group born of a merge. */
  gi: number
  gj: number
  /** Fine-segment members of each side, and each side's opaque pixel count + mean sRGB
   *  (over every pixel of the members, not the strided sample). */
  membersI: number[]
  membersJ: number[]
  pxI: number
  pxJ: number
  meanI: [number, number, number]
  meanJ: [number, number, number]
  /** How far the pair got. Only 'evaluated' pairs carry finite terms below. */
  reached: 'flat-pinned' | 'gate' | 'edge-veto' | 'no-fit' | 'evaluated'
  /** The acceptance condition's four terms: union-fit Oklab residual (≤ mergeTol),
   *  profile gap (≤ maxProfileGap), unwitnessed jump (≤ maxUnwitnessedJump unless the
   *  flat-flank escape holds: min(solidI, solidJ) > FLAT_FLANK_RES). NaN when unreached. */
  res: number
  gap: number
  jump: number
  solidI: number
  solidJ: number
  /** The union fit that produced those terms. */
  fitType?: 'linear' | 'radial'
  stops?: number
  fit?: GradientFill
  /** Sample count per bin of the fitted parameter t (the bins profileGap reads);
   *  shows whether the two sides abut in t. */
  bins?: number[]
  /** Where along t the `jump` sits, and the widest sample-free stretch of t strictly
   *  inside the union's own [tmin, tmax] (fraction of [0,1]). */
  jumpT?: number
  holeT?: number
  /** 'eval': the pair qualifies as a merge candidate. 'merged': always true. */
  accepted: boolean
  /** 'merged' only: the new group's id. */
  c?: number
}
export type MergePairObserver = (r: MergePairRecord) => void

export const DEFAULT_SEGMENT_OPTIONS: SegmentOptions = {
  ms: DEFAULT_MS_OPTIONS,
  tauS: 10,
  sigma: 5,
  tauA: 0.25,
  minFacing: 4,
  mergeTol: 0.06,
  maxProfileGap: 0.34,
  maxUnwitnessedJump: 0.12,
  mergeGradients: true,
  sampleCap: 3000,
  minRegionArea: 0,
  meanGate: 0,
}

export interface SegmentResult extends QuantizeResult {
  /** Mumford–Shah by-products (diagnostics; not required downstream). */
  ms: MumfordShahResult
  /** Number of fine segments S₀ before discontinuity-aware merging. */
  fineSegments: number
  /**
   * Per-pixel pre-merge region id: the fine segments (S₀) before the Step-3c
   * gradient merge fuses them into macro-regions. −1 for anti-aliased /
   * transparent pixels. The editor highlights these on hover so the user can
   * pick one to keep flat. (`labels` is the final, post-merge map.)
   */
  preMergeLabels: Int32Array
  /**
   * Per macro-region (parallel to `palette`/`counts`), the smooth-pixel samples
   * used for the merge, anti-aliased 𝒟 pixels excluded, so the paint model is fit
   * on clean colours without boundary-distance weighting.
   */
  regionSamples: RegionSamples[]
}
