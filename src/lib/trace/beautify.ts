// Options for the beautify pass (primitive snaps, line polish, relation solver).
// The pass itself is edge-level and lives in planarBeautify.ts, with the fitting
// math in circleFit.ts; the planar pipeline never ran the old loop-level pass
// (moving loops independently would desync edges two regions share).
//
// Every snap is gated by the user-facing fidelity tolerance: accepted only if the
// maximum deviation it introduces from the raw flattened trace stays ≤ `fidelity`
// px. `fidelity = 0` disables beautification.

export interface BeautifyOptions {
  /**
   * Max deviation (px) any snap may introduce from the raw trace — the user
   * fidelity knob. A snap is accepted only when its worst-case drift stays under
   * this. 0 disables all beautification (output is the raw trace).
   */
  fidelity: number
  /** Concentric-centre / equal-radius detection radius, as a fraction of the
   *  whole-document bbox long side. */
  relationFrac: number
  /** Angle (deg) within which a straight edge snaps to horizontal/vertical. */
  hvAngleDeg: number
}

export const DEFAULT_BEAUTIFY_OPTIONS: BeautifyOptions = {
  fidelity: 1.5,
  relationFrac: 0.1,
  hvAngleDeg: 10,
}
