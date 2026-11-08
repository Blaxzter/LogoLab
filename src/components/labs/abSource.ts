// /labs/ab's verdict against the SOURCE.
//
// The diff heat says WHERE two revisions differ, not which one is right. A change that moves
// every boundary by a fraction of a pixel (the boundary solve) lights up every edge in it,
// toward the art and away from it alike, and the review drowns. So each side of a changed lane
// is also scored against the input both of them traced, with the studio's own ΔE
// (`deltaEField`, the source's alpha composited over white): the row says closer or further,
// and the page can put the cases that moved AWAY from the art first.
//
// Pure (no DOM): the lab hands in pixels, so the arithmetic is testable headless.

import type { AbLaneKey } from '../../../bench/abCorpus.ts'
import { deltaEField, deltaEStats } from '../../lib/render/fidelity.ts'

/** Scored at the studio's size. A 2048 lane halved moves the mean by about 0.005 and costs a
 *  quarter of the work. */
export const SOURCE_SCORE_LONG = 1024
/** A shift under this is a tie: the scoring size alone moves the mean about this much. */
export const SOURCE_TIE_DE = 0.005

export interface Pixels {
  data: Uint8ClampedArray
  width: number
  height: number
}

export interface SourceScore {
  lane: AbLaneKey
  label: string
  /** Mean ΔE against the source: the baseline stamp's trace, and the other side's. */
  base: number
  head: number
}

export type SourceVerdict = 'closer' | 'further' | 'same'

/** The top-left `w` × `h` of `p` (a copy, or `p` itself when it already is that size). */
function crop(p: Pixels, w: number, h: number): Uint8ClampedArray {
  if (p.width === w && p.height === h) return p.data
  const out = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) out.set(p.data.subarray(y * p.width * 4, (y * p.width + w) * 4), y * w * 4)
  return out
}

/**
 * Mean ΔE of a render against its source. The two are scaled from one size by two different
 * rasterizers and can round a row or a column apart; the common area is scored. Null when they
 * disagree by more than that (not the same picture).
 */
export function meanDeltaEVsSource(source: Pixels, render: Pixels): number | null {
  const w = Math.min(source.width, render.width)
  const h = Math.min(source.height, render.height)
  if (w < 1 || h < 1) return null
  if (Math.max(source.width, render.width) - w > 1 || Math.max(source.height, render.height) - h > 1) return null
  return deltaEStats(deltaEField(crop(source, w, h), crop(render, w, h), w, h).de).meanDeltaE
}

export function sourceVerdict(s: Pick<SourceScore, 'base' | 'head'>): SourceVerdict {
  const d = s.head - s.base
  return d > SOURCE_TIE_DE ? 'further' : d < -SOURCE_TIE_DE ? 'closer' : 'same'
}

/** The lane that moved furthest from the source (largest head − base), or null with none scored.
 *  The page sorts by it, so a lane that got worse outranks every lane that got better. */
export function worstShift(scores: readonly SourceScore[] | undefined): SourceScore | null {
  let worst: SourceScore | null = null
  for (const s of scores ?? []) if (!worst || s.head - s.base > worst.head - worst.base) worst = s
  return worst
}

/** Order for "worst against the source first": scored rows by their worst shift, descending;
 *  rows with nothing scored (unchanged, failed, still running) keep their order after them. */
export function byWorstShift<T>(rows: readonly T[], scores: (row: T) => readonly SourceScore[] | undefined): T[] {
  const keyed = rows.map((row, i) => {
    const w = worstShift(scores(row))
    return { row, i, k: w ? w.head - w.base : null }
  })
  keyed.sort((a, b) => {
    if (a.k == null || b.k == null) return a.k == null && b.k == null ? a.i - b.i : a.k == null ? 1 : -1
    return b.k - a.k || a.i - b.i
  })
  return keyed.map((x) => x.row)
}

/** A change in ΔE as the page prints it: `+0.008`, `−0.186`, and `±0.000` for none (a tiny
 *  negative printed as `−0.000` reads as an improvement). */
export function signedDelta(d: number): string {
  return Math.abs(d) < 0.0005 ? '±0.000' : `${d > 0 ? '+' : '−'}${Math.abs(d).toFixed(3)}`
}

/** `ΔE 0.198 (−0.186)` for a panel: its own score, and the change from its partner. */
export function deltaENote(own: number | undefined, partner: number | undefined): string {
  if (own === undefined) return ''
  const d = partner === undefined ? 0 : own - partner
  return ` · ΔE ${own.toFixed(3)}${Math.abs(d) < 0.0005 ? '' : ` (${signedDelta(d)})`}`
}
