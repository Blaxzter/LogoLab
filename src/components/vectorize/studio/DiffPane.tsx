// The Difference view: the ΔE heat over a ghost of the source, with its legend and probe.

import { useEffect, useMemo, useRef, useState } from "react";
import type { PanZoom } from "../../../hooks/usePanZoom";
import { heatCss } from "../../../lib/heat";
import { diffPicture, probeDiff, type DiffProbe } from "../../../lib/render/diffView";
import { HEAT_FULL_SCALE_DE } from "../../../lib/render/fidelity";
import type { TraceScore } from "../../../lib/render/scoreOffThread";
import { ZoomSurface } from "../../ui/ZoomSurface";
import { useFitBox } from "../useFitBox";

/**
 * The Difference view: per-pixel ΔE between the rendered result and the source,
 * on the same cold→hot ramp /labs/ab uses.
 *
 * The heat is laid over a dim ghost of the source (lib/render/diffView.ts) and
 * the pointer reads the field back under the cursor. Everything comes from the
 * buffers the score returned; this pane measures nothing itself.
 *
 * Framed like OriginalPane so switching modes doesn't move the art. Painted via
 * a canvas-owned ImageData because the DOM `ImageData` constructor's type
 * rejects a plain Uint8ClampedArray. Goes `pixelated` once a heat pixel is wider
 * than a screen pixel, so a one-pixel seam isn't smeared.
 */
export function DiffPane({
    pz,
    score,
    primary = false,
}: {
    pz: PanZoom;
    score: TraceScore;
    primary?: boolean;
}) {
    const fit = useFitBox(score.width, score.height);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const boxRef = useRef<HTMLDivElement | null>(null);
    // Pointer position in raster-normalized units, not a sampled value, so a new
    // score re-reads the same spot instead of blanking the readout.
    const [cursor, setCursor] = useState<{ nx: number; ny: number } | null>(null);
    const probe = useMemo(
        () => (cursor ? probeDiff(score, cursor.nx, cursor.ny) : null),
        [score, cursor],
    );

    useEffect(() => {
        const cv = canvasRef.current;
        if (!cv) return;
        cv.width = score.width;
        cv.height = score.height;
        const ctx = cv.getContext("2d");
        if (!ctx) return;
        const id = ctx.createImageData(score.width, score.height);
        id.data.set(
            diffPicture(score.heat, score.de, score.source, score.width, score.height),
        );
        ctx.putImageData(id, 0, 0);
    }, [score]);

    const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
        const rect = boxRef.current?.getBoundingClientRect();
        if (!rect || rect.width === 0 || rect.height === 0) return;
        setCursor({
            nx: (e.clientX - rect.left) / rect.width,
            ny: (e.clientY - rect.top) / rect.height,
        });
    };

    // Screen pixels per heat pixel: past 1 the browser's bilinear upscale would
    // smear every one-pixel seam into a soft two-pixel one.
    const magnified = fit.width > 0 && (pz.scale * fit.width) / score.width > 1;

    return (
        <>
            <ZoomSurface pz={pz} primary={primary} className="h-full w-full">
                <div
                    ref={fit.parentRef}
                    className="flex h-full w-full items-center justify-center p-[6%]"
                >
                    <div
                        ref={boxRef}
                        className="relative"
                        style={{ width: fit.width, height: fit.height }}
                        onPointerMove={handlePointerMove}
                        onPointerLeave={() => setCursor(null)}
                    >
                        <canvas
                            ref={canvasRef}
                            className="pointer-events-none block h-full w-full select-none"
                            style={{ imageRendering: magnified ? "pixelated" : "auto" }}
                        />
                    </div>
                </div>
            </ZoomSurface>
            <HeatLegend score={score} probe={probe} />
        </>
    );
}

/** The heat's scale and this trace's numbers (the only ΔE readout on mobile,
 *  which has no status bar). Sampled at the ramp's seven stops so the CSS
 *  gradient matches exactly. With a pointer over the art it also shows that
 *  pixel's two colours and their ΔE, which tells an edge that moved slightly
 *  apart from a wrong colour. */
function HeatLegend({
    score,
    probe,
}: {
    score: TraceScore;
    probe: DiffProbe | null;
}) {
    const ramp = Array.from({ length: 7 }, (_, i) => heatCss(i / 6)).join(", ");
    return (
        <div className="pointer-events-none absolute bottom-2 left-2 rounded-md border border-line bg-surface/85 px-2 py-1.5 font-mono text-[10px] tabular-nums text-muted backdrop-blur">
            <div>
                mean {score.meanDeltaE.toFixed(2)} · p95{" "}
                {score.p95DeltaE.toFixed(2)}
            </div>
            <div className="mt-1 flex items-center gap-1.5">
                <span>0</span>
                <span
                    className="h-2 w-24 rounded-sm"
                    style={{ background: `linear-gradient(to right, ${ramp})` }}
                />
                <span>≥{HEAT_FULL_SCALE_DE} ΔE vs original</span>
            </div>
            {probe && (
                <div className="mt-1 flex items-center gap-1.5">
                    <span>
                        {probe.x},{probe.y}
                    </span>
                    <Swatch rgb={probe.source} />
                    <span>original</span>
                    <Swatch rgb={probe.render} />
                    <span>trace</span>
                    <span className="text-ink-2">ΔE {probe.deltaE.toFixed(2)}</span>
                </div>
            )}
        </div>
    );
}

function Swatch({ rgb }: { rgb: [number, number, number] }) {
    return (
        <span
            className="inline-block h-2.5 w-2.5 rounded-sm border border-line"
            style={{ background: `rgb(${rgb[0]},${rgb[1]},${rgb[2]})` }}
        />
    );
}
