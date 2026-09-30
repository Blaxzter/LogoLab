// "Find best settings": the candidates the studio tries, the rule that picks one,
// and the scoreboard's words. Pure, in a `.ts` so test/best-settings.test.ts and
// bench/bestSettingsDiag.ts import exactly what ships.
//
// Each candidate is a patch over the studio's options plus its Mode and recolour,
// built from what the studio already knows about the image: the mono cut and invert
// come from the same `decideInkMode` `freshSettings` uses, forced to mono. The
// user's own settings (smoothing, despeckle, fidelity, markers, …) ride along into
// every one. Measured and tuned in docs/vectorization-benchmarks.md §40.

import { applyInkMode, decideInkMode, type InkModePlan } from '../../../lib/traceInput/ink.ts'
import type { VectorizeOptions } from '../../../types.ts'

export { forceColorDoc } from './forceColorDoc.ts'

/** Long side (px) of the reduced copy every candidate is traced and scored on. */
export const SEARCH_MAX_DIM = 352

/** Candidates traced side by side (one worker each). */
export const SEARCH_CONCURRENCY = 2

export type CandidateId = 'strokes' | 'mono' | 'flat' | 'backplate' | 'gradients'

/**
 * Simplest first. The order is the tie-break: within `SIMPLER_WINS_DE` of the best
 * ΔE the earliest candidate wins, because a mono trace that looks the same as a
 * colour one is the better file.
 */
export const CANDIDATE_ORDER: readonly CandidateId[] = ['strokes', 'mono', 'flat', 'backplate', 'gradients']

/**
 * The order the pool STARTS them in: slowest first. Gradients is the long pole on
 * nearly every slow case (§40), so it starts at once and the cheap candidates fill
 * the other worker around it instead of trailing it.
 */
export const TRACE_ORDER: readonly CandidateId[] = ['gradients', 'backplate', 'flat', 'mono', 'strokes']

/** Wall time of `ms` (per candidate, in TRACE_ORDER) on a pool of `workers`: each job goes to the first free one. */
export function poolWallMs(ms: readonly number[], workers = SEARCH_CONCURRENCY): number {
  const free = new Array(Math.max(1, workers)).fill(0)
  for (const t of ms) {
    const i = free.indexOf(Math.min(...free))
    free[i] += t
  }
  return Math.max(...free)
}

export interface Candidate {
  id: CandidateId
  /** Scoreboard name, e.g. "Flat · gradients off". */
  label: string
  /**
   * The options this candidate decides. A key set to `undefined` is removed; a key
   * not listed is the user's and carries over (smoothing, despeckle, markers, …).
   */
  patch: Partial<VectorizeOptions>
  /** The full options it was traced with: the patch over the options at search time. */
  opts: VectorizeOptions
  /** What the Mode control shows once applied. */
  colorMode: 'color' | 'mono'
  forceColorOn: boolean
  /** The recolour swatch, when the candidate brings one (the probed ink). */
  forceColor: string | null
}

export const CANDIDATE_LABELS: Record<CandidateId, string> = {
  strokes: 'Mono · strokes',
  mono: 'Mono',
  flat: 'Flat · gradients off',
  backplate: 'Flat · gradient backdrop',
  gradients: 'Colour · gradients on',
}

/**
 * `current` with a candidate's decisions applied and everything else kept: a
 * runner-up clicked after the user moved a slider keeps that slider.
 */
export function withCandidate(current: VectorizeOptions, c: Pick<Candidate, 'patch'>): VectorizeOptions {
  const next = { ...current }
  for (const [k, v] of Object.entries(c.patch)) {
    if (v === undefined) delete (next as Record<string, unknown>)[k]
    else (next as Record<string, unknown>)[k] = v
  }
  return next
}

/**
 * The candidates for this image.
 *
 * Mono is always FORCED here: a forced plan still measures the cut and invert, so
 * a multi-ink image gets a real silhouette to score rather than a 128 cut.
 *
 * @param current the studio's options now (the user's own settings carry over)
 * @param pixels the raster to measure the mono cut on (the ink probe's), or null
 *   (then only the colour candidates can be built)
 * @param include which candidates to build (all of them by default)
 */
export function buildCandidates(
  current: VectorizeOptions,
  pixels: ImageData | null,
  include: readonly CandidateId[] = CANDIDATE_ORDER,
): Candidate[] {
  const mono: InkModePlan | null = pixels ? decideInkMode(pixels, current.threshold, { colorMode: 'mono' }) : null
  const out: Candidate[] = []
  const push = (id: CandidateId, patch: Partial<VectorizeOptions>, paint: string | null) =>
    out.push({
      id,
      label: CANDIDATE_LABELS[id],
      patch,
      opts: withCandidate(current, { patch }),
      colorMode: patch.mode === 'mono' ? 'mono' : 'color',
      forceColorOn: paint != null,
      forceColor: paint,
    })
  for (const id of CANDIDATE_ORDER) {
    if (!include.includes(id)) continue
    if (id === 'strokes' || id === 'mono') {
      if (!mono) continue
      // Painted in the probed ink even when it is near-black. `freshSettings` leaves
      // a #14161c ink as the tracer's #000, which costs ~1.5 ΔE on a one-ink mark
      // and would hand every such mark to Flat, which paints the real colour.
      const paint = mono.recolor != null && mono.recolor.toLowerCase() !== '#000000' ? mono.recolor : null
      const { mode, threshold, invert } = applyInkMode(current, mono)
      // Mono leaves `centerline` absent rather than false, so a winner that matches
      // a fresh upload's settings reads as those settings (Reset stays off).
      push(id, { mode, threshold, invert, centerline: id === 'strokes' ? true : undefined }, paint)
      continue
    }
    // Colour ignores the mono cut, so threshold and invert stay as they were;
    // Strokes is cleared, or a later flip to Mono would come back as strokes.
    push(
      id,
      {
        mode: 'color',
        gradients: id === 'gradients',
        backgroundGradient: id === 'backplate' ? true : undefined,
        centerline: undefined,
      },
      null,
    )
  }
  return out
}

/* ------------------------------------------------------------- the winner */

export interface CandidateScore {
  id: CandidateId
  /** Mean CIE76 ΔE of the candidate's render against the reduced source. */
  meanDeltaE: number
  nodes: number
}

/**
 * A simpler candidate (earlier in `CANDIDATE_ORDER`) whose ΔE is within this of
 * the best one wins. Below the ΔE76 JND (~2.3): the difference is not visible,
 * the smaller, single-ink file is.
 */
export const SIMPLER_WINS_DE = 0.3

/** Rank by ΔE, then hand the win to the simplest candidate within `margin` of the best. */
export function pickWinner(scores: readonly CandidateScore[], margin = SIMPLER_WINS_DE): CandidateScore[] {
  const valid = scores.filter((s) => Number.isFinite(s.meanDeltaE))
  if (!valid.length) return []
  const byDe = [...valid].sort((a, b) => a.meanDeltaE - b.meanDeltaE || a.nodes - b.nodes)
  const best = byDe[0].meanDeltaE
  const rank = (s: CandidateScore) => CANDIDATE_ORDER.indexOf(s.id)
  const close = byDe.filter((s) => s.meanDeltaE <= best + margin)
  const winner = close.reduce((w, s) => (rank(s) < rank(w) || (rank(s) === rank(w) && s.nodes < w.nodes) ? s : w))
  return [winner, ...byDe.filter((s) => s !== winner)]
}

/**
 * Why the winner won, when ΔE alone would have picked another: "Mono is within 0.3
 * ΔE of the closest match, and simpler." Null when it is also the closest match.
 */
export function winnerNote(ranked: readonly (CandidateScore & { candidate?: { label: string } })[]): string | null {
  if (ranked.length < 2) return null
  const [winner, ...rest] = ranked
  const closest = rest.reduce((m, s) => (s.meanDeltaE < m.meanDeltaE ? s : m), winner)
  if (closest === winner || closest.meanDeltaE >= winner.meanDeltaE) return null
  const label = winner.candidate?.label ?? CANDIDATE_LABELS[winner.id]
  return `${label} is within ${SIMPLER_WINS_DE} ΔE of the closest match, and simpler.`
}

/* ------------------------------------------------------------ the scoreboard */

/** "ΔE 1.8 · 44 nodes" — the numbers a scoreboard row quotes. */
export function scoreLine(s: Pick<CandidateScore, 'meanDeltaE' | 'nodes'>): string {
  return `ΔE ${s.meanDeltaE.toFixed(1)} · ${s.nodes} ${s.nodes === 1 ? 'node' : 'nodes'}`
}
