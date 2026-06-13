// Node-editing SVG canvas for the vectorize studio. Renders an EditableDoc
// inside a shared pan/zoom surface and (in node mode) lets the user drag whole
// paths, anchors and Bézier handles, insert nodes on segments, and toggle
// corner/smooth joints — Affinity-style.
//
// Coordinate model: the doc's viewBox aspect is fitted into the available
// space as an explicitly-sized "fitted box"; the <svg> fills that box exactly,
// so the svg element rect IS the drawing rect and pointer → viewBox mapping is
// a plain proportion off getBoundingClientRect() (the pan/zoom CSS transform
// is already baked into that rect). All gestures compute from a pointerdown
// snapshot with cumulative deltas, so previews never accumulate drift.

import { memo, useEffect, useRef, useState, useCallback } from "react";
import { ZoomSurface } from "../ui/ZoomSurface";
import type { PanZoom } from "../../hooks/usePanZoom";
import type {
    EditableDoc,
    DocItem,
    GradientFill,
    NodeRef,
    PathItem,
    RawItem,
    Vec,
} from "../../lib/path/types";
import { subPathsToD } from "../../lib/path/model";
import {
    insertNode,
    moveHandle,
    moveNodes,
    nearestPointOnItem,
    setNodeKind,
    translateItem,
} from "../../lib/path/geometry";

const ACCENT = "#5b5bd6";
/** Selected anchor fill — warm hue that contrasts the indigo outline/stroke. */
const ACCENT_SEL = "#f25f2e";
/** White halo/ring colour, keeps the overlay legible over any artwork. */
const HALO = "#ffffff";
/** Screen-px movement before a pointerdown counts as a drag (not a click). */
const DRAG_THRESHOLD_PX = 3;
/** Max screen-px distance from a segment for double-click node insertion. */
const INSERT_MAX_PX = 12;
/** Screen-px radius for double-clicking an anchor (toggle corner/smooth). */
const ANCHOR_HIT_PX = 8;
/** Screen-px radius treated as "on a handle dot" (dblclick no-op). */
const HANDLE_HIT_PX = 7;

export interface EditorCanvasProps {
    doc: EditableDoc;
    pz: PanZoom;
    tool: "pan" | "node";
    /** False while tracing — render only, no editing. */
    editable: boolean;
    selectedPathId: string | null;
    /** Selected node keys, 'sub:idx'. */
    selectedNodes: ReadonlySet<string>;
    /** Original-image ghost rendered under the SVG (overlay view mode). */
    underlay?: { src: string; opacity: number } | null;
    onSelectPath: (id: string | null) => void;
    onSelectNodes: (keys: Set<string>) => void;
    /** Live preview during drags (no history commit). */
    onDocChange: (doc: EditableDoc) => void;
    /** History-committing final state (pointerup, double-click edits). */
    onDocCommit: (doc: EditableDoc) => void;
    /** Forwarded to ZoomSurface — registers the box the +/- buttons zoom around. */
    primary?: boolean;
}

/**
 * Fit an aspect ratio into the observed size of a container ("contain"),
 * returning explicit pixel dimensions for the fitted box. ResizeObserver-based
 * so it tracks layout (untransformed) size — the pan/zoom CSS transform scales
 * the box visually without re-measuring.
 */
export function useFitBox(aspectW: number, aspectH: number) {
    const parentRef = useRef<HTMLDivElement | null>(null);
    const [avail, setAvail] = useState({ w: 0, h: 0 });

    useEffect(() => {
        const el = parentRef.current;
        if (!el) return;
        const ro = new ResizeObserver((entries) => {
            const r = entries[0]?.contentRect;
            if (r) setAvail({ w: r.width, h: r.height });
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    const ratio = aspectW > 0 && aspectH > 0 ? aspectW / aspectH : 1;
    let width = avail.w;
    let height = width / ratio;
    if (height > avail.h) {
        height = avail.h;
        width = height * ratio;
    }
    return { parentRef, width, height };
}

/** Replace one item (matched by id) in a doc, sharing everything else. */
function withItem(doc: EditableDoc, item: DocItem): EditableDoc {
    return {
        ...doc,
        items: doc.items.map((it) => (it.id === item.id ? item : it)),
    };
}

function parseNodeKey(key: string): NodeRef {
    const [sub, idx] = key.split(":").map(Number);
    return { sub, idx };
}

// subPathsToD is pure string work over an immutable array — cache per subPaths
// identity so the static layer, hit layer and selection outline share one pass.
const dCache = new WeakMap<object, string>();
function dOf(item: PathItem): string {
    let d = dCache.get(item.subPaths);
    if (d === undefined) {
        d = subPathsToD(item.subPaths);
        dCache.set(item.subPaths, d);
    }
    return d;
}

function escapeAttr(v: string): string {
    return v
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/"/g, "&quot;");
}

interface DragState {
    type: "path" | "nodes" | "handle";
    /** Doc the live preview is computed from (includes an alt-corner pre-edit). */
    origDoc: EditableDoc;
    /** Doc as it was before pointerdown — the Escape/cancel restore target. */
    preDoc: EditableDoc;
    origItem: PathItem;
    refs?: NodeRef[];
    handleRef?: NodeRef;
    which?: "in" | "out";
    mirror?: boolean;
    startClient: { x: number; y: number };
    startVb: Vec;
    moved: boolean;
    lastDoc: EditableDoc | null;
    pointerId: number;
}

/** SVG paint-server element for a gradient fill (userSpaceOnUse). */
function GradientDef({ id, gradient }: { id: string; gradient: GradientFill }) {
    const stops = gradient.stops.map((s, i) => (
        <stop
            key={i}
            offset={s.offset}
            stopColor={s.color}
            stopOpacity={s.opacity ?? 1}
        />
    ));
    if (gradient.type === "linear") {
        return (
            <linearGradient
                id={id}
                gradientUnits="userSpaceOnUse"
                x1={gradient.x1}
                y1={gradient.y1}
                x2={gradient.x2}
                y2={gradient.y2}
            >
                {stops}
            </linearGradient>
        );
    }
    return (
        <radialGradient
            id={id}
            gradientUnits="userSpaceOnUse"
            cx={gradient.cx}
            cy={gradient.cy}
            r={gradient.r}
            fx={gradient.fx}
            fy={gradient.fy}
        >
            {stops}
        </radialGradient>
    );
}

/** Memoized static fill — re-renders only when the item identity changes. */
const PathView = memo(function PathView({
    item,
    interactive,
}: {
    item: PathItem;
    interactive: boolean;
}) {
    const gid = item.gradient ? `grad-${item.id}` : null;
    return (
        <>
            {item.gradient && (
                <defs>
                    <GradientDef id={gid!} gradient={item.gradient} />
                </defs>
            )}
            <path
                data-id={item.id}
                d={dOf(item)}
                fill={gid ? `url(#${gid})` : item.fill}
                fillOpacity={item.fillOpacity}
                fillRule={item.fillRule}
                style={
                    interactive
                        ? { pointerEvents: "visiblePainted", cursor: "move" }
                        : undefined
                }
            />
        </>
    );
});

/** Invisible wide-stroke copy so thin outlines are grabbable in node mode. */
const HitPath = memo(function HitPath({
    item,
    width,
}: {
    item: PathItem;
    width: number;
}) {
    return (
        <path
            data-id={item.id}
            d={dOf(item)}
            fill="none"
            stroke="transparent"
            strokeWidth={width}
            style={{ pointerEvents: "stroke", cursor: "move" }}
        />
    );
});

/** Verbatim markup, re-wrapped in its captured ancestor context (mirrors serializeDoc). */
const RawView = memo(function RawView({ item }: { item: RawItem }) {
    const inherited = item.inherited ?? {};
    const keys = Object.keys(inherited);
    let html = item.markup;
    if (item.transform || keys.length > 0) {
        let open = "<g";
        if (item.transform)
            open += ` transform="${escapeAttr(item.transform)}"`;
        for (const key of keys)
            open += ` ${key}="${escapeAttr(inherited[key])}"`;
        html = `${open}>${item.markup}</g>`;
    }
    return (
        <g
            style={{ pointerEvents: "none" }}
            dangerouslySetInnerHTML={{ __html: html }}
        />
    );
});

export function EditorCanvas({
    doc,
    pz,
    tool,
    editable,
    selectedPathId,
    selectedNodes,
    underlay,
    onSelectPath,
    onSelectNodes,
    onDocChange,
    onDocCommit,
    primary = false,
}: EditorCanvasProps) {
    const [vbX, vbY, vbW, vbH] = doc.viewBox;
    const fit = useFitBox(vbW, vbH);
    const boxRef = useRef<HTMLDivElement | null>(null);
    const svgRef = useRef<SVGSVGElement | null>(null);
    const dragRef = useRef<DragState | null>(null);
    // Key of the anchor/handle currently under the cursor ('sub:idx' or
    // 'sub:idx:in|out'), for hover feedback in node mode.
    const [hoveredKey, setHoveredKey] = useState<string | null>(null);

    // --- marquee (rubber-band) selection state ---
    interface MarqueeState {
        startVb: Vec;
        currentVb: Vec;
        startClient: { x: number; y: number };
        moved: boolean;
        pointerId: number;
        /** If the marquee started on a path body, store its id for click-to-select. */
        hitPathId?: string;
    }
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
    // px per viewBox unit at the current zoom (fit.width is the layout size; the
    // pan/zoom transform multiplies it on screen). Guard the pre-measure frame.
    const screenScale = fit.width > 0 ? (fit.width * pz.scale) / vbW : 1;

    const sel = doc.items.find((it) => it.id === selectedPathId);
    const selectedItem = sel && sel.kind === "path" ? sel : null;

    // The grab targets unmount on selection / mode change without firing
    // pointerout, so drop any stale hover highlight explicitly.
    useEffect(() => {
        setHoveredKey(null);
    }, [selectedPathId, interactive]);

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

    // NOTE: capture deliberately does NOT happen here. Capturing on pointerdown
    // makes the browser retarget the derived click/dblclick events to the svg
    // root, which kills double-click-to-insert / -toggle (the handler's
    // closest('[data-id]') then starts from <svg> and finds nothing). The
    // capture happens in handleSvgPointerMove once the drag threshold is
    // crossed — pure clicks never capture.
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
        const id = (e.target as Element)
            .closest("[data-id]")
            ?.getAttribute("data-id");
        if (!id) return;
        const item = doc.items.find((it) => it.id === id);
        if (!item || item.kind !== "path") return;
        e.stopPropagation();

        const pt = toVb(e.clientX, e.clientY);
        if (!pt) return;

        if (interactive) {
            // Dragging on the SELECTED path → move that path (existing behavior).
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
            // Dragging on a DIFFERENT path → start a marquee; pure click selects it.
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

    // One precise double-click handler on the svg root. DOM-target-based routing
    // is hopeless here: once a path is selected, its (generous) invisible grab
    // circles blanket the outline — a circle's Bézier handle dots sit almost ON
    // the curve — so a dblclick "on the segment" usually lands on a grab target.
    // Instead, hit-test geometrically with priorities: anchor (toggle kind) →
    // handle dot (swallow) → segment (insert node) → painted fill (swallow) →
    // background (fall through to ZoomSurface's zoom reset).
    const handleSvgDoubleClick = (e: React.MouseEvent<SVGSVGElement>) => {
        if (!interactive) return;
        const pt = toVb(e.clientX, e.clientY);
        if (!pt) return;
        const scale = liveScale();

        if (selectedItem) {
            // 1) Anchor: toggle corner ↔ smooth.
            let bestRef: NodeRef | null = null;
            let bestDist = ANCHOR_HIT_PX / scale;
            let onHandle = false;
            selectedItem.subPaths.forEach((sp, sub) =>
                sp.nodes.forEach((node, idx) => {
                    const d = Math.hypot(node.x - pt.x, node.y - pt.y);
                    if (d <= bestDist) {
                        bestDist = d;
                        bestRef = { sub, idx };
                    }
                    for (const h of [node.hIn, node.hOut]) {
                        if (
                            h &&
                            Math.hypot(h.x - pt.x, h.y - pt.y) <=
                                HANDLE_HIT_PX / scale
                        )
                            onHandle = true;
                    }
                }),
            );
            if (bestRef) {
                e.stopPropagation();
                const ref: NodeRef = bestRef;
                const node = selectedItem.subPaths[ref.sub].nodes[ref.idx];
                onDocCommit(
                    withItem(
                        doc,
                        setNodeKind(
                            selectedItem,
                            ref,
                            node.kind === "smooth" ? "corner" : "smooth",
                        ),
                    ),
                );
                return;
            }
            // 2) Handle dot: dblclick is a no-op, but never a zoom reset.
            if (onHandle) {
                e.stopPropagation();
                return;
            }
        }

        // 3) Segment: insert a node. Prefer the selected path, else the topmost
        //    visible path whose outline is within tolerance.
        const tolerance = INSERT_MAX_PX / scale;
        const candidates: PathItem[] = [];
        if (selectedItem) candidates.push(selectedItem);
        for (let i = doc.items.length - 1; i >= 0; i--) {
            const it = doc.items[i];
            if (it.kind === "path" && it.visible && it !== selectedItem)
                candidates.push(it);
        }
        for (const item of candidates) {
            const hit = nearestPointOnItem(item, pt);
            if (!hit || hit.dist > tolerance) continue;
            e.stopPropagation();
            const next = insertNode(item, hit.sub, hit.seg, hit.t);
            if (next === item) return;
            onSelectPath(item.id);
            onSelectNodes(new Set([`${hit.sub}:${hit.seg + 1}`]));
            onDocCommit(withItem(doc, next));
            return;
        }

        // 4) Inside a painted shape (not near its outline): swallow, so a stray
        //    dblclick doesn't yank the zoom back. True background falls through.
        if ((e.target as Element).closest("[data-id]")) e.stopPropagation();
    };

    // --- anchors & handles -------------------------------------------------------

    const handleGrabPointerDown = (e: React.PointerEvent<SVGGElement>) => {
        if (e.button !== 0 || !e.isPrimary || !selectedItem) return;
        const t = e.target as Element;
        const nodeKey = t.getAttribute("data-node");
        const handleKey = t.getAttribute("data-handle");
        if (!nodeKey && !handleKey) return;
        e.stopPropagation();
        const pt = toVb(e.clientX, e.clientY);
        if (!pt) return;
        const startClient = { x: e.clientX, y: e.clientY };

        if (nodeKey) {
            let next: Set<string>;
            if (e.shiftKey) {
                next = new Set(selectedNodes);
                if (next.has(nodeKey)) next.delete(nodeKey);
                else next.add(nodeKey);
            } else if (!selectedNodes.has(nodeKey)) {
                next = new Set([nodeKey]);
            } else {
                next = new Set(selectedNodes);
            }
            onSelectNodes(next);
            if (next.size === 0) return;
            beginDrag(e, {
                type: "nodes",
                origDoc: doc,
                preDoc: doc,
                origItem: selectedItem,
                refs: [...next].map(parseNodeKey),
                startClient,
                startVb: pt,
                moved: false,
                lastDoc: null,
                pointerId: e.pointerId,
            });
            return;
        }

        const [subS, idxS, which] = handleKey!.split(":");
        const ref: NodeRef = { sub: Number(subS), idx: Number(idxS) };
        const node = selectedItem.subPaths[ref.sub]?.nodes[ref.idx];
        if (!node) return;
        // Alt breaks symmetry: the node becomes a corner before the (unmirrored)
        // handle drag, so smooth-mirroring stops following this handle.
        let baseDoc = doc;
        let baseItem = selectedItem;
        if (e.altKey && node.kind !== "corner") {
            baseItem = setNodeKind(selectedItem, ref, "corner");
            baseDoc = withItem(doc, baseItem);
            onDocChange(baseDoc);
        }
        beginDrag(e, {
            type: "handle",
            origDoc: baseDoc,
            preDoc: doc,
            origItem: baseItem,
            handleRef: ref,
            which: which === "in" ? "in" : "out",
            mirror: !e.altKey,
            startClient,
            startVb: pt,
            moved: false,
            lastDoc: null,
            pointerId: e.pointerId,
        });
    };

    // --- drag tracking on the svg root (pointer capture retargets here) ----------

    const handleSvgPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
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
        const dx = pt.x - drag.startVb.x;
        const dy = pt.y - drag.startVb.y;
        let item: PathItem;
        if (drag.type === "path") {
            item = translateItem(drag.origItem, dx, dy);
        } else if (drag.type === "nodes") {
            item = moveNodes(drag.origItem, drag.refs!, dx, dy);
        } else {
            item = moveHandle(
                drag.origItem,
                drag.handleRef!,
                drag.which!,
                pt,
                drag.mirror!,
            );
        }
        const next = withItem(drag.origDoc, item);
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
                    const keys = new Set<string>(
                        e.shiftKey ? selectedNodes : [],
                    );
                    selectedItem.subPaths.forEach((sp, sub) =>
                        sp.nodes.forEach((node, idx) => {
                            if (
                                node.x >= x0 &&
                                node.x <= x1 &&
                                node.y >= y0 &&
                                node.y <= y1
                            ) {
                                keys.add(`${sub}:${idx}`);
                            }
                        }),
                    );
                    onSelectNodes(keys);
                } else {
                    // No path selected: select the first path that has nodes inside the box
                    for (let i = doc.items.length - 1; i >= 0; i--) {
                        const it = doc.items[i];
                        if (it.kind !== "path" || !it.visible) continue;
                        let hasNode = false;
                        const keys = new Set<string>();
                        it.subPaths.forEach((sp, sub) =>
                            sp.nodes.forEach((node, idx) => {
                                if (
                                    node.x >= x0 &&
                                    node.x <= x1 &&
                                    node.y >= y0 &&
                                    node.y <= y1
                                ) {
                                    hasNode = true;
                                    keys.add(`${sub}:${idx}`);
                                }
                            }),
                        );
                        if (hasNode) {
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

    const r = (px: number) => px / screenScale;

    return (
        <ZoomSurface pz={pz} primary={primary} className="h-full w-full">
            <div
                ref={fit.parentRef}
                className="flex h-full w-full items-center justify-center p-[6%]"
            >
                <div
                    ref={boxRef}
                    className="relative"
                    style={{ width: fit.width, height: fit.height }}
                >
                    {underlay && (
                        <img
                            src={underlay.src}
                            alt=""
                            draggable={false}
                            className="pointer-events-none absolute inset-0 h-full w-full select-none"
                            style={{ opacity: underlay.opacity }}
                        />
                    )}
                    <svg
                        ref={svgRef}
                        viewBox={`${vbX} ${vbY} ${vbW} ${vbH}`}
                        width="100%"
                        height="100%"
                        className={interactive ? "cursor-crosshair" : ""}
                        style={{
                            display: "block",
                            touchAction: "none",
                            // Pan mode / render-only: the surface beneath pans & zooms freely.
                            pointerEvents: interactive ? undefined : "none",
                        }}
                        onPointerDown={handleSvgPointerDown}
                        onPointerMove={handleSvgPointerMove}
                        onPointerUp={handleSvgPointerUp}
                        onPointerCancel={handleSvgPointerCancel}
                        onDoubleClick={handleSvgDoubleClick}
                    >
                        <g onPointerDown={handlePathPointerDown}>
                            {doc.items.map((item) =>
                                item.kind === "path"
                                    ? item.visible && (
                                          <PathView
                                              key={item.id}
                                              item={item}
                                              interactive={interactive}
                                          />
                                      )
                                    : item.visible && (
                                          <RawView key={item.id} item={item} />
                                      ),
                            )}
                            {interactive &&
                                doc.items.map((item) =>
                                    item.kind === "path" && item.visible ? (
                                        <HitPath
                                            key={item.id}
                                            item={item}
                                            width={r(10)}
                                        />
                                    ) : null,
                                )}
                        </g>

                        {/* Selection overlay: outline + handle spokes/dots + anchors.
                            All widths/radii go through r() so they stay a constant
                            screen size at every zoom (the markers' convention) — the
                            CSS zoom transform would otherwise fatten a plain stroke. */}
                        {selectedItem && fit.width > 0 && (
                            <g style={{ pointerEvents: "none" }}>
                                {/* White halo under the accent line keeps the outline
                                    legible even when the path's own colour is the accent. */}
                                <path
                                    d={dOf(selectedItem)}
                                    fill="none"
                                    stroke={HALO}
                                    strokeOpacity={0.85}
                                    strokeWidth={r(3.5)}
                                    strokeLinejoin="round"
                                />
                                <path
                                    d={dOf(selectedItem)}
                                    fill="none"
                                    stroke={ACCENT}
                                    strokeWidth={r(1.5)}
                                    strokeLinejoin="round"
                                />
                                {selectedItem.subPaths.map((sp, sub) =>
                                    sp.nodes.map((node, idx) => {
                                        const key = `${sub}:${idx}`;
                                        const isSel = selectedNodes.has(key);
                                        const isHover = hoveredKey === key;
                                        const hoverIn =
                                            hoveredKey === `${sub}:${idx}:in`;
                                        const hoverOut =
                                            hoveredKey === `${sub}:${idx}:out`;
                                        // Selected anchors use a warm fill (not the
                                        // accent) so they stay visible sitting on the
                                        // accent-coloured outline.
                                        const anchorFill = isSel
                                            ? ACCENT_SEL
                                            : HALO;
                                        const anchorStroke = isSel
                                            ? HALO
                                            : isHover
                                              ? ACCENT_SEL
                                              : ACCENT;
                                        const anchorW = r(isHover ? 1.6 : 1.2);
                                        return (
                                            <g key={key}>
                                                {node.hIn && (
                                                    <line
                                                        x1={node.x}
                                                        y1={node.y}
                                                        x2={node.hIn.x}
                                                        y2={node.hIn.y}
                                                        stroke={ACCENT}
                                                        strokeOpacity={0.55}
                                                        strokeWidth={r(1)}
                                                    />
                                                )}
                                                {node.hOut && (
                                                    <line
                                                        x1={node.x}
                                                        y1={node.y}
                                                        x2={node.hOut.x}
                                                        y2={node.hOut.y}
                                                        stroke={ACCENT}
                                                        strokeOpacity={0.55}
                                                        strokeWidth={r(1)}
                                                    />
                                                )}
                                                {node.hIn && (
                                                    <circle
                                                        cx={node.hIn.x}
                                                        cy={node.hIn.y}
                                                        r={r(hoverIn ? 4.25 : 3.25)}
                                                        fill={
                                                            hoverIn
                                                                ? ACCENT_SEL
                                                                : HALO
                                                        }
                                                        stroke={ACCENT}
                                                        strokeWidth={r(1.2)}
                                                    />
                                                )}
                                                {node.hOut && (
                                                    <circle
                                                        cx={node.hOut.x}
                                                        cy={node.hOut.y}
                                                        r={r(hoverOut ? 4.25 : 3.25)}
                                                        fill={
                                                            hoverOut
                                                                ? ACCENT_SEL
                                                                : HALO
                                                        }
                                                        stroke={ACCENT}
                                                        strokeWidth={r(1.2)}
                                                    />
                                                )}
                                                {node.kind === "smooth" ? (
                                                    <circle
                                                        cx={node.x}
                                                        cy={node.y}
                                                        r={r(
                                                            isHover ? 4.75 : 3.75,
                                                        )}
                                                        fill={anchorFill}
                                                        stroke={anchorStroke}
                                                        strokeWidth={anchorW}
                                                    />
                                                ) : (
                                                    <rect
                                                        x={
                                                            node.x -
                                                            r(isHover ? 4.5 : 3.5)
                                                        }
                                                        y={
                                                            node.y -
                                                            r(isHover ? 4.5 : 3.5)
                                                        }
                                                        width={r(isHover ? 9 : 7)}
                                                        height={r(isHover ? 9 : 7)}
                                                        fill={anchorFill}
                                                        stroke={anchorStroke}
                                                        strokeWidth={anchorW}
                                                    />
                                                )}
                                            </g>
                                        );
                                    }),
                                )}
                            </g>
                        )}

                        {/* Invisible grab targets over anchors & handle dots (node tool). */}
                        {interactive && selectedItem && fit.width > 0 && (
                            <g
                                onPointerDown={handleGrabPointerDown}
                                onPointerOver={(e) => {
                                    const t = e.target as Element;
                                    const k =
                                        t.getAttribute("data-node") ??
                                        t.getAttribute("data-handle");
                                    if (k) setHoveredKey(k);
                                }}
                                onPointerOut={() => setHoveredKey(null)}
                            >
                                {selectedItem.subPaths.map((sp, sub) =>
                                    sp.nodes.map((node, idx) => (
                                        <g key={`${sub}:${idx}`}>
                                            {node.hIn && (
                                                <circle
                                                    cx={node.hIn.x}
                                                    cy={node.hIn.y}
                                                    r={r(8)}
                                                    fill="none"
                                                    data-handle={`${sub}:${idx}:in`}
                                                    style={{
                                                        pointerEvents: "all",
                                                        cursor: "crosshair",
                                                    }}
                                                />
                                            )}
                                            {node.hOut && (
                                                <circle
                                                    cx={node.hOut.x}
                                                    cy={node.hOut.y}
                                                    r={r(8)}
                                                    fill="none"
                                                    data-handle={`${sub}:${idx}:out`}
                                                    style={{
                                                        pointerEvents: "all",
                                                        cursor: "crosshair",
                                                    }}
                                                />
                                            )}
                                            <circle
                                                cx={node.x}
                                                cy={node.y}
                                                r={r(8)}
                                                fill="none"
                                                data-node={`${sub}:${idx}`}
                                                style={{
                                                    pointerEvents: "all",
                                                    cursor: "move",
                                                }}
                                            />
                                        </g>
                                    )),
                                )}
                            </g>
                        )}

                        {/* Marquee selection rectangle */}
                        {marqueeRect && (
                            <rect
                                x={marqueeRect.x}
                                y={marqueeRect.y}
                                width={marqueeRect.w}
                                height={marqueeRect.h}
                                fill="rgba(91, 91, 214, 0.08)"
                                stroke={ACCENT}
                                strokeWidth={r(1)}
                                strokeDasharray={`${r(4)} ${r(2)}`}
                                style={{ pointerEvents: "none" }}
                            />
                        )}
                    </svg>
                </div>
            </div>
        </ZoomSurface>
    );
}
