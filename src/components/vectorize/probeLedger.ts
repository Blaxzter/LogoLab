// Which image the studio's auto-probes have DECIDED for.
//
// The two probes in VectorizeStudio (the ink probe and the rampiness probe) are
// each two things at once: a measurement (what ink is this? does it ramp?) and a
// default (so set Mode / the cut / Gradients accordingly). A RESTORED session
// wants the first without the second — the options on screen are the user's
// own, and a probe overwriting them is the "my settings reset themselves" bug.
//
// The trap is WHAT "restored" is keyed to. It used to be a boolean armed at
// mount whenever a stored view existed at all — which, after the first ever
// visit, is always — and consumed only when a probe actually RAN. A vector
// source in "Clean SVG" mode never probes, so the flag sat armed across any
// number of uploads and then ate the first probe that did run: a fresh upload,
// or the same SVG once the user switched Source to Re-trace. That image got the
// persisted options of whatever came before it (colour + gradients at 1024 for
// one-ink sheet music, instead of the mono cut at 2048 the probe had measured),
// while the panel under Mode correctly said "One ink → Mono".
//
// So the restore is keyed to the IMAGE instead: a probe only measures when the
// stored view records that it was decided for exactly the pixels on screen
// (`assetKey`, which the store reissues whenever the working pixels change).
// A view that records no image — stored before the field existed, or saved
// while a "Clean SVG" source sat unprobed — is not a decision for anything, and
// the probe applies as it would on a fresh image. Pure, and in its own `.ts` so
// `test/probe-ledger.test.ts` can reach it.

/** The asset a restored view was decided for, or null when it records none. */
export function restoredDecision(view: { probedAssetKey?: string | null } | null): string | null {
  return view?.probedAssetKey ?? null
}

/**
 * Whether a probe about to run on `assetKey` should APPLY its decision, or only
 * measure. It applies unless the options on screen were already decided for
 * this very image — a restore.
 */
export function probeShouldApply(decidedFor: string | null, assetKey: string): boolean {
  return decidedFor !== assetKey
}
