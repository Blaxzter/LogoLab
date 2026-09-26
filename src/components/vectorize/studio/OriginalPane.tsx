// The source image pane, framed like the editor canvas, where region markers are placed.

import { useRef } from "react";
import type { PanZoom } from "../../../hooks/usePanZoom";
import { ZoomSurface } from "../../ui/ZoomSurface";
import { useFitBox } from "../useFitBox";

/** Region-marker glyph colour (emerald) + halo, matching EditorCanvas. */
const MARKER_FILL = "#10b981";
const FLAT_MARKER_FILL = "#f59e0b"; // amber — "flat colour" markers
const REMOVE_MARKER_FILL = "#f43f5e"; // rose — "remove & heal" markers
const MARKER_HALO = "#ffffff";
/** Screen-px radius for clicking an existing marker to remove it. */
const MARKER_HIT_PX = 11;

/**
 * The original image in the same centred-fit framing as the editor canvas, so
 * split view lines up. With the Mark tool active it also accepts markers, mapped
 * to the same normalized [0,1] coords the editor uses. Pins counter-scale by the
 * zoom to stay a constant screen size.
 */
export function OriginalPane({
    pz,
    src,
    aspectW,
    aspectH,
    primary = false,
    markers,
    marking = false,
    onAddMarker,
    onRemoveMarker,
}: {
    pz: PanZoom;
    src: string;
    aspectW: number;
    aspectH: number;
    primary?: boolean;
    markers?: { x: number; y: number; flat?: boolean; remove?: boolean }[];
    marking?: boolean;
    onAddMarker?: (x: number, y: number) => void;
    onRemoveMarker?: (index: number) => void;
}) {
    const fit = useFitBox(aspectW, aspectH);
    const boxRef = useRef<HTMLDivElement | null>(null);
    const all = markers ?? [];

    const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
        if (!marking || e.button !== 0) return;
        const rect = boxRef.current?.getBoundingClientRect();
        if (!rect || rect.width === 0 || rect.height === 0) return;
        e.stopPropagation(); // don't let ZoomSurface treat this as a pan
        // Click an existing pin (within a screen-px tolerance) → remove; else add.
        let hit = -1;
        let bestD = MARKER_HIT_PX;
        for (let i = 0; i < all.length; i++) {
            const px = rect.left + all[i].x * rect.width;
            const py = rect.top + all[i].y * rect.height;
            const d = Math.hypot(px - e.clientX, py - e.clientY);
            if (d <= bestD) {
                bestD = d;
                hit = i;
            }
        }
        if (hit >= 0) {
            onRemoveMarker?.(hit);
            return;
        }
        const nx = (e.clientX - rect.left) / rect.width;
        const ny = (e.clientY - rect.top) / rect.height;
        if (nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1) onAddMarker?.(nx, ny);
    };

    const inv = pz.scale > 0 ? 1 / pz.scale : 1;
    // Once a source pixel is wider than a screen pixel, render it pixelated: a
    // smoothed image would hide what the raster holds. Same rule as the Difference
    // heat; `aspectW` is the source's natural width.
    const magnified = fit.width > 0 && (pz.scale * fit.width) / aspectW > 1;
    return (
        <ZoomSurface pz={pz} primary={primary} className="h-full w-full">
            <div
                ref={fit.parentRef}
                className="flex h-full w-full items-center justify-center p-[6%]"
            >
                <div
                    ref={boxRef}
                    className="relative"
                    style={{ width: fit.width, height: fit.height, cursor: marking ? "crosshair" : undefined }}
                    onPointerDown={handlePointerDown}
                >
                    <img
                        src={src}
                        alt=""
                        draggable={false}
                        className="pointer-events-none h-full w-full select-none"
                        style={{ imageRendering: magnified ? "pixelated" : "auto" }}
                    />
                    {all.length > 0 &&
                        all.map((m, i) => (
                            <div
                                key={i}
                                className="pointer-events-none absolute"
                                style={{
                                    left: `${m.x * 100}%`,
                                    top: `${m.y * 100}%`,
                                    width: 14,
                                    height: 14,
                                    borderRadius: m.flat ? "3px" : "9999px",
                                    background: m.remove
                                        ? REMOVE_MARKER_FILL
                                        : m.flat
                                          ? FLAT_MARKER_FILL
                                          : MARKER_FILL,
                                    border: `2px solid ${MARKER_HALO}`,
                                    boxShadow: "0 0 0 1px rgba(0,0,0,.25)",
                                    transform: `translate(-50%, -50%) scale(${inv})`,
                                }}
                            />
                        ))}
                </div>
            </div>
        </ZoomSurface>
    );
}
