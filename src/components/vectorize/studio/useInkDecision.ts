// Colour vs mono: the Mode control, the ink probe's plan, and the mono cut it measured.

import { useCallback, useMemo, useRef, useState } from "react";
import { DEFAULT_VECTORIZE_OPTIONS } from "../../../lib/trace";
import {
    applyInkMode,
    cutFraction,
    decideInkMode,
    inkLumaRange,
    type InkColorMode,
    type InkModePlan,
} from "../../../lib/traceInput/ink";
import type { VectorizeOptions } from "../../../types";
import type { StudioSeed } from "../studioSession";
import type { SetOpts } from "./types";

/**
 * Above this Rec.709 luma the probed ink is clearly not black, so a mono trace
 * (always #000) is repainted with the ink's colour by default.
 */
const INK_IS_BLACK_LUMA = 32;

export function useInkDecision({
    session,
    initialOptions,
    opts,
    setOpts,
    setForceColor,
    setForceColorOn,
}: {
    session: StudioSeed;
    initialOptions: VectorizeOptions | undefined;
    opts: VectorizeOptions;
    setOpts: SetOpts;
    setForceColor: (c: string) => void;
    setForceColorOn: (on: boolean) => void;
}) {
    // Colour vs mono, the mono cut, and invert. `auto` asks the ink probe
    // (src/lib/traceInput/ink.ts), the same decision /sheet and the MCP server make. A host
    // that already planned the trace (the icon sheet) passes its own mode.
    const [colorMode, setColorMode] = useState<InkColorMode>(
        initialOptions ? initialOptions.mode : (session.view?.colorMode ?? "auto"),
    );
    // Read inside the probe effect so flipping Mode doesn't re-run (and re-decode) it.
    const colorModeRef = useRef<InkColorMode>(colorMode);
    // What the probe last saw — drives the "why" line under Mode, and the offer to
    // paint a mono trace in the ink's own colour instead of #000.
    const [inkPlan, setInkPlan] = useState<InkModePlan | null>(null);
    // The probed 512px raster, kept so a Mode flip re-decides without re-decoding.
    const probePixelsRef = useRef<ImageData | null>(null);
    // Pins the force-colour toggle once the user touches it, so the ink offer
    // never overrides a deliberate choice (same contract as gradientsTouchedRef).
    const forceColorTouchedRef = useRef(session.view?.forceColorTouched ?? false);

    /**
     * Resolve colour/mono for the current image and push it into the options.
     * Called on a fresh probe and whenever Mode changes: a forced Mono still wants
     * the measured cut and invert flag.
     *
     * `apply: false` only records the measurement (for the "why" line and the mono
     * guide) and leaves the options alone, as a restored session needs.
     */
    // biome-ignore lint/correctness/useExhaustiveDependencies: the setters are the studio's, stable
    const applyInkDecision = useCallback(
        (mode: InkColorMode, pixels?: ImageData | null, apply = true) => {
            const img = pixels ?? probePixelsRef.current;
            if (!img) {
                // No probe result yet (or the decode failed). An explicit choice still
                // applies, without a measured cut; Auto waits for the probe.
                if (apply && mode !== "auto") {
                    setOpts((o) => (o.mode === mode ? o : { ...o, mode }));
                }
                return;
            }
            const plan = decideInkMode(img, DEFAULT_VECTORIZE_OPTIONS.threshold, {
                colorMode: mode,
            });
            setInkPlan(plan);
            if (!apply) return;
            setOpts((o) => {
                const next = applyInkMode(o, plan);
                // Avoid a spurious re-trace when nothing actually moved.
                return next.mode === o.mode &&
                    next.threshold === o.threshold &&
                    (next.invert ?? false) === (o.invert ?? false)
                    ? o
                    : next;
            });
            // A mono trace comes back #000. Seed the recolor with the ink's real colour,
            // and turn it on when the ink is clearly not black (e.g. white on navy).
            if (plan.recolor && !forceColorTouchedRef.current) {
                setForceColor(plan.recolor);
                setForceColorOn(
                    plan.probe.inkLuma != null && plan.probe.inkLuma > INK_IS_BLACK_LUMA,
                );
            }
        },
        [],
    );

    /**
     * What the current mono cut admits, so the panel can show an empty result
     * before it happens. Keyed on `inkPlan` because it is set from the same pixels
     * as `probePixelsRef`, which the memo can't observe directly.
     */
    const monoGuide = useMemo(() => {
        const img = probePixelsRef.current;
        if (!img || !inkPlan || opts.mode !== "mono") return null;
        const range = inkLumaRange(img);
        if (!range) return null;
        return {
            // Cuts that select nothing: with Invert off the ink is below the cut, so cuts
            // at or under the darkest pixel are dead; with it on, cuts at or over the
            // lightest. The all-solid end isn't marked: on art over transparency that is
            // the silhouette, a real result.
            deadOff: Math.floor(range.min),
            deadOn: Math.ceil(range.max),
            fracOff: cutFraction(img, opts.threshold, false),
            fracOn: cutFraction(img, opts.threshold, true),
        };
    }, [inkPlan, opts.mode, opts.threshold]);

    /** Reset the mono cut to what the probe measured for this image. */
    // biome-ignore lint/correctness/useExhaustiveDependencies: setOpts is the studio's, stable
    const useMeasuredCut = useCallback(() => {
        if (!inkPlan) return;
        setOpts((o) => ({
            ...o,
            threshold: inkPlan.threshold,
            invert: inkPlan.invert,
        }));
    }, [inkPlan]);

    return {
        colorMode,
        setColorMode,
        colorModeRef,
        inkPlan,
        probePixelsRef,
        forceColorTouchedRef,
        applyInkDecision,
        monoGuide,
        useMeasuredCut,
    };
}
