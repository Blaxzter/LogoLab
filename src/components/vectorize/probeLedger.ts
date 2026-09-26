// Records which image the studio's auto-probes have decided options for.
//
// The ink and rampiness probes in VectorizeStudio both measure (what ink is
// this? does it ramp?) and set defaults from that. A restored session wants the
// measurement without the defaults, or the probes overwrite the user's options.
//
// "Restored" is keyed to the image (`assetKey`), not to a flag armed at mount.
// Don't switch to a mount flag: a stored view exists after the first visit, and a
// "Clean SVG" source never probes, so the flag survives an upload and hands the
// next image the previous image's options. A view that records no image is not a
// decision for anything, so the probe applies as on a fresh image.
//
// Pure, in a `.ts` so test/probe-ledger.test.ts can import it.

/** The asset a restored view was decided for, or null when it records none. */
export function restoredDecision(view: { probedAssetKey?: string | null } | null): string | null {
  return view?.probedAssetKey ?? null
}

/**
 * Whether a probe about to run on `assetKey` should apply its decision or only
 * measure. It applies unless the options on screen were already decided for
 * this image (a restore).
 */
export function probeShouldApply(decidedFor: string | null, assetKey: string): boolean {
  return decidedFor !== assetKey
}
