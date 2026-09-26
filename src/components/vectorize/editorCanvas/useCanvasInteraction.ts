// Pointer, drag, marquee and hover state for the node-edit canvas (EditorCanvas).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EditableDoc, Vec } from "../../../lib/path/types";
import { nearestGrab } from "../nodeOverlay";
import { DRAG_THRESHOLD_PX, HIT, MARKER_HIT_PX } from "./constants";
import { doubleClickEdit } from "./doubleClickEdit";
import {
    addNodesInRect,
    type DragState,
    dragPreview,
    type MarqueeState,
    markerIndexAt,
    type PreMerge,
    preMergeLabelAt,
    type RegionMarker,
    regionMaskUrl,
    removeRegionDAt,
} from "./geometry";
import { startGrab } from "./grabGesture";

export interface CanvasInteractionArgs {
    doc: EditableDoc;
    tool: "pan" | "node" | "mark";
    editable: boolean;
    selectedPathId: string | null;
    selectedNodes: ReadonlySet<string>;
    markers?: RegionMarker[];
    markMode: "separate" | "flat" | "remove";
    preMerge?: PreMerge | null;
    onSelectPath: (id: string | null) => void;
    onSelectNodes: (keys: Set<string>) => void;
    onRegionSeed?: (id: string, pt: Vec) => void;
    onDocChange: (doc: EditableDoc) => void;
    onDocCommit: (doc: EditableDoc) => void;
    onAddMarker?: (x: number, y: number) => void;
    onRemoveMarker?: (index: number) => void;
}

export function useCanvasInteraction({
    doc,
    tool,
    editable,
    selectedPathId,
    selectedNodes,
    markers,
    markMode,
    preMerge,
    onSelectPath,
    onSelectNodes,
    onRegionSeed,
    onDocChange,
    onDocCommit,
    onAddMarker,
    onRemoveMarker,
}: CanvasInteractionArgs) {
    const [vbX, vbY, vbW, vbH] = doc.viewBox;
    const boxRef = useRef<HTMLDivElement | null>(null);
    const svgRef = useRef<SVGSVGElement | null>(null);
    const dragRef = useRef<DragState | null>(null);
    // Key of the anchor/handle currently under the cursor ('sub:idx' or
    // 'sub:idx:in|out'), for hover feedback in node mode.
    const [hoveredKey, setHoveredKey] = useState<string | null>(null);
    // Mark tool: the pre-merge region label under the cursor.
    const [hoverLabel, setHoverLabel] = useState<number | null>(null);
    // Remove mode: the d-string of the final region a click would dissolve.
    const [removeHoverD, setRemoveHoverD] = useState<string | null>(null);
    // Mark tool: the cursor position (viewBox coords) for the ghost marker.
    const [hoverPt, setHoverPt] = useState<Vec | null>(null);

    // --- marquee (rubber-band) selection state ---
    const marqueeRef = useRef<MarqueeState | null>(null);
    const [marqueeRect, setMarqueeRect] = useState<{
        x: number;
        y: number;
        w: number;
        h: number;
    } | null>(null);

    const endMarquee = useCallback(() => {
        const m = marqueeRef.current;
        marqueeRef.current = null;
        setMarqueeRect(null);
        if (m) {
            try {
                svgRef.current?.releasePointerCapture(m.pointerId);
            } catch {
                /* ok */
            }
        }
        return m;
    }, []);

    const interactive = tool === "node" && editable;
    // Mark tool: click the stage to add a region marker, click a marker to remove
    // it. Independent of node editing (no selection/marquee machinery).
    const marking = tool === "mark" && editable;

    // Region hover-highlight overlay (mark tool, flat mode only): rasterize the
    // pre-merge region under the cursor to a tinted mask, as a data-URL <image> over
    // the viewBox. Recomputed only when the hovered label changes (O(w·h) per region
    // entered, not per mouse-move).
    const hoverOverlay = useMemo(() => {
        if (hoverLabel === null || hoverLabel < 0 || !preMerge) return null;
        return regionMaskUrl(preMerge, hoverLabel);
    }, [preMerge, hoverLabel]);

    const sel = doc.items.find((it) => it.id === selectedPathId);
    const selectedItem = sel && sel.kind === "path" ? sel : null;

    // The grab targets unmount on selection / mode change without firing
    // pointerout, so drop any stale hover highlight explicitly.
    useEffect(() => {
        setHoveredKey(null);
    }, [selectedPathId, interactive]);

    // Drop the remove-preview whenever we leave remove mode (or marking entirely),
    // and the ghost marker whenever we leave the mark tool.
    useEffect(() => {
        if (!marking || markMode !== "remove") setRemoveHoverD(null);
        if (!marking) setHoverPt(null);
    }, [marking, markMode]);

    /** Map client coords to viewBox coords via the fitted box's live rect. */
    const toVb = (clientX: number, clientY: number): Vec | null => {
        const box = boxRef.current;
        if (!box) return null;
        const rect = box.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return null;
        return {
            x: vbX + ((clientX - rect.left) / rect.width) * vbW,
            y: vbY + ((clientY - rect.top) / rect.height) * vbH,
        };
    };

    /** Live px-per-unit, straight off the rect (for hit radii inside handlers). */
    const liveScale = (): number => {
        const rect = boxRef.current?.getBoundingClientRect();
        return rect && rect.width > 0 ? rect.width / vbW : 1;
    };

    // Don't capture the pointer here: capturing on pointerdown retargets the
    // derived click/dblclick to the svg root, which breaks double-click insert /
    // toggle. handleSvgPointerMove captures once the drag threshold is crossed.
    const beginDrag = (_e: React.PointerEvent, drag: DragState) => {
        dragRef.current = drag;
    };

    const endDrag = () => {
        const drag = dragRef.current;
        if (!drag) return null;
        dragRef.current = null;
        try {
            svgRef.current?.releasePointerCapture(drag.pointerId);
        } catch {
            /* already released */
        }
        return drag;
    };

    // Escape mid-drag cancels: restore the pre-gesture doc, never commit. The
    // capture-phase listener runs before (and suppresses) the studio's own
    // Escape handling, so a cancel doesn't also clear the selection.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== "Escape") return;
            if (marqueeRef.current) {
                e.preventDefault();
                e.stopPropagation();
                endMarquee();
                return;
            }
            if (!dragRef.current) return;
            e.preventDefault();
            e.stopPropagation();
            const drag = endDrag();
            if (drag) onDocChange(drag.preDoc);
        };
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
    }, [onDocChange, endMarquee]);

    // --- path body: select + potential whole-path drag / marquee ----------------

    const handlePathPointerDown = (e: React.PointerEvent<SVGGElement>) => {
        if (e.button !== 0 || !e.isPrimary) return;
        // Mark tool: don't select/drag the path — let the event bubble to the svg
        // root, which places/removes a marker at the click point.
        if (marking) return;
        const id = (e.target as Element).closest("[data-id]")?.getAttribute("data-id");
        if (!id) return;
        const item = doc.items.find((it) => it.id === id);
        if (!item || item.kind !== "path") return;
        e.stopPropagation();

        const pt = toVb(e.clientX, e.clientY);
        if (!pt) return;

        // Remember the click as the "remove & heal" seed, so a later ⌫ dissolves
        // the blob under it rather than the whole colour.
        onRegionSeed?.(item.id, pt);

        if (interactive) {
            // Dragging on the selected path moves it.
            if (id === selectedPathId) {
                beginDrag(e, {
                    type: "path",
                    origDoc: doc,
                    preDoc: doc,
                    origItem: item,
                    startClient: { x: e.clientX, y: e.clientY },
                    startVb: pt,
                    moved: false,
                    lastDoc: null,
                    pointerId: e.pointerId,
                });
                return;
            }
            // Dragging on a different path starts a marquee; a click selects it.
            marqueeRef.current = {
                startVb: pt,
                currentVb: pt,
                startClient: { x: e.clientX, y: e.clientY },
                moved: false,
                pointerId: e.pointerId,
                hitPathId: id,
            };
            return;
        }

        onSelectPath(id);
        beginDrag(e, {
            type: "path",
            origDoc: doc,
            preDoc: doc,
            origItem: item,
            startClient: { x: e.clientX, y: e.clientY },
            startVb: pt,
            moved: false,
            lastDoc: null,
            pointerId: e.pointerId,
        });
    };

    const handleSvgDoubleClick = (e: React.MouseEvent<SVGSVGElement>) =>
        doubleClickEdit(e, {
            marking,
            interactive,
            doc,
            selectedItem,
            toVb,
            liveScale,
            onSelectPath,
            onSelectNodes,
            onDocCommit,
        });

    // --- anchors & handles -------------------------------------------------------

    /** The anchor / handle dot under a client point, as a nodeOverlay grab key. */
    const grabAt = (clientX: number, clientY: number): string | null => {
        if (!selectedItem) return null;
        const pt = toVb(clientX, clientY);
        if (!pt) return null;
        return nearestGrab(selectedItem, pt, (8 * HIT) / liveScale());
    };

    // Capture phase on the svg: a grab beats the path body and the marquee
    // underneath it.
    const handleGrabPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
        if (!interactive || e.button !== 0 || !e.isPrimary || !selectedItem) return;
        const key = grabAt(e.clientX, e.clientY);
        if (!key) return;
        startGrab(e, key, { doc, selectedItem, selectedNodes, toVb, onSelectNodes, onDocChange, beginDrag });
    };

    // --- drag tracking on the svg root (pointer capture retargets here) ----------

    const handleSvgPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
        // --- anchor / handle hover (node tool, nothing in flight) ---
        if (interactive && selectedItem && !dragRef.current && !marqueeRef.current) {
            const k = grabAt(e.clientX, e.clientY);
            if (k !== hoveredKey) setHoveredKey(k);
        }
        // --- region hover-highlight (mark tool) ---
        if (marking) {
            // The ghost marker rides the pointer (the crosshair is hidden).
            const pt = toVb(e.clientX, e.clientY);
            setHoverPt(pt);
            // Remove mode: preview the final region the click would dissolve,
            // hit-tested against the rendered geometry.
            if (markMode === "remove") {
                const d = pt ? removeRegionDAt(doc, pt) : null;
                setRemoveHoverD((prev) => (prev === d ? prev : d));
                return;
            }
            // Flat markers carve the hovered section out as its own region, so the
            // preview maps to what the click does. "Keep separate" acts by a ridge
            // split the pre-merge map doesn't predict, so no preview there.
            if (markMode !== "flat" || !preMerge) {
                setHoverLabel((prev) => (prev === null ? prev : null));
                return;
            }
            const lab = preMergeLabelAt(preMerge, pt, doc.viewBox);
            setHoverLabel((prev) => (prev === lab ? prev : lab));
            return;
        }

        // --- marquee tracking ---
        const m = marqueeRef.current;
        if (m) {
            if (!m.moved) {
                const dx = e.clientX - m.startClient.x;
                const dy = e.clientY - m.startClient.y;
                if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
                m.moved = true;
                try {
                    svgRef.current?.setPointerCapture(m.pointerId);
                } catch {
                    /* ok */
                }
            }
            const pt = toVb(e.clientX, e.clientY);
            if (!pt) return;
            m.currentVb = pt;
            const x = Math.min(m.startVb.x, pt.x);
            const y = Math.min(m.startVb.y, pt.y);
            const w = Math.abs(pt.x - m.startVb.x);
            const h = Math.abs(pt.y - m.startVb.y);
            setMarqueeRect({ x, y, w, h });
            return;
        }

        // --- existing drag logic ---
        const drag = dragRef.current;
        if (!drag) return;
        if (!drag.moved) {
            const dx = e.clientX - drag.startClient.x;
            const dy = e.clientY - drag.startClient.y;
            if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
            drag.moved = true;
            // A real drag is underway — now capture, so moves keep flowing even
            // when the pointer leaves the svg. (See note on beginDrag.)
            try {
                svgRef.current?.setPointerCapture(drag.pointerId);
            } catch {
                /* capture unavailable */
            }
        }
        const pt = toVb(e.clientX, e.clientY);
        if (!pt) return;
        const next = dragPreview(drag, pt);
        drag.lastDoc = next;
        onDocChange(next);
    };

    const handleSvgPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
        // --- marquee finalize ---
        const m = marqueeRef.current;
        if (m) {
            const moved = m.moved;
            endMarquee();
            if (moved) {
                // Select all nodes within the marquee rect on the selected path
                const x0 = Math.min(m.startVb.x, m.currentVb.x);
                const y0 = Math.min(m.startVb.y, m.currentVb.y);
                const x1 = Math.max(m.startVb.x, m.currentVb.x);
                const y1 = Math.max(m.startVb.y, m.currentVb.y);

                if (selectedItem) {
                    // Select nodes of the already-selected path within the box
                    const keys = new Set<string>(e.shiftKey ? selectedNodes : []);
                    addNodesInRect(selectedItem, x0, y0, x1, y1, keys);
                    onSelectNodes(keys);
                } else {
                    // No path selected: select the first path that has nodes inside the box
                    for (let i = doc.items.length - 1; i >= 0; i--) {
                        const it = doc.items[i];
                        if (it.kind !== "path" || !it.visible) continue;
                        const keys = new Set<string>();
                        if (addNodesInRect(it, x0, y0, x1, y1, keys)) {
                            onSelectPath(it.id);
                            onSelectNodes(keys);
                            break;
                        }
                    }
                }
                return;
            }
            // Pure click (no drag) — select the hit path, or clear selection
            if (m.hitPathId) {
                onSelectPath(m.hitPathId);
            } else {
                if (selectedNodes.size > 0) onSelectNodes(new Set());
                if (selectedPathId) onSelectPath(null);
            }
            return;
        }

        // --- existing drag logic ---
        const drag = endDrag();
        if (!drag) return;
        if (drag.moved && drag.lastDoc) onDocCommit(drag.lastDoc);
        // Pure click after an alt pre-edit: revert the uncommitted preview.
        else if (drag.preDoc !== drag.origDoc) onDocChange(drag.preDoc);
    };

    const handleSvgPointerCancel = () => {
        endMarquee();
        const drag = endDrag();
        if (drag) onDocChange(drag.preDoc);
    };

    /** Empty-canvas pointerdown: in node mode, start a potential marquee drag.
     *  If it's a plain click (no movement) we clear selection on pointerup. */
    const handleSvgPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
        if (e.button !== 0) return; // middle-drag pans without touching selection
        if (marking) {
            const pt = toVb(e.clientX, e.clientY);
            if (!pt) return;
            e.stopPropagation(); // prevent ZoomSurface from panning
            // Click an existing marker (within tolerance) → remove it; else add a
            // new one. Hit-test geometrically so it works under any pan/zoom.
            const scale = liveScale();
            const hit = markerIndexAt(markers ?? [], pt, doc.viewBox, (MARKER_HIT_PX * HIT) / scale);
            if (hit >= 0) {
                onRemoveMarker?.(hit);
            } else {
                const nx = (pt.x - vbX) / vbW;
                const ny = (pt.y - vbY) / vbH;
                if (nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1) onAddMarker?.(nx, ny);
            }
            return;
        }
        if (interactive) {
            const pt = toVb(e.clientX, e.clientY);
            if (!pt) return;
            e.stopPropagation(); // prevent ZoomSurface from panning
            marqueeRef.current = {
                startVb: pt,
                currentVb: pt,
                startClient: { x: e.clientX, y: e.clientY },
                moved: false,
                pointerId: e.pointerId,
            };
            return; // defer selection clearing until pointerup (may become a marquee)
        }
        if (selectedNodes.size > 0) onSelectNodes(new Set());
        if (selectedPathId) onSelectPath(null);
    };

    const handleSvgPointerLeave = () => {
        if (hoverLabel !== null) setHoverLabel(null);
        if (removeHoverD !== null) setRemoveHoverD(null);
        if (hoverPt !== null) setHoverPt(null);
        if (hoveredKey !== null && !dragRef.current) setHoveredKey(null);
    };

    return {
        boxRef,
        svgRef,
        interactive,
        marking,
        selectedItem,
        hoveredKey,
        removeHoverD,
        hoverPt,
        hoverOverlay,
        marqueeRect,
        handlePathPointerDown,
        handleGrabPointerDown,
        handleSvgPointerDown,
        handleSvgPointerMove,
        handleSvgPointerUp,
        handleSvgPointerCancel,
        handleSvgPointerLeave,
        handleSvgDoubleClick,
    };
}
