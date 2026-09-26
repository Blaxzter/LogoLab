// Pure geometry + hit-testing for the node-edit canvas (plain .ts so tests can import it).

import type { DocItem, EditableDoc, NodeRef, PathItem, SubPath, Vec } from "../../../lib/path/types";
import { subPathsToD } from "../../../lib/path/model";
import { flattenSubPath, pointInPolygon, polygonArea } from "../../../lib/editor/hitTest";
import { moveHandle, moveNodes, translateItem } from "../../../lib/path/geometry";
import type { HandleSite, NodeProvenance } from "../../../lib/path/topology";
import { moveEdgeHandle, translateRegion, translateRegionNodes } from "../../../lib/path/topologyEdit";

/** Pre-merge region map (fine regions before the field-merge) from the last trace. */
export interface PreMerge {
    labels: Int32Array;
    width: number;
    height: number;
}

/** A region marker (segmentation seed) in normalized [0,1] image coords. */
export interface RegionMarker {
    x: number;
    y: number;
    flat?: boolean;
    remove?: boolean;
}

export interface DragState {
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
    /** Planar (topological) selected item: route edits through doc.topology so
     *  the neighbour region follows. Captured at pointerdown and valid for the
     *  whole drag (moves never change node counts). Absent ⇒ per-item editing. */
    provenance?: NodeProvenance[][];
    /** Handle drag on a planar item: the canonical edge handle to drag. */
    handleSite?: HandleSite;
}

// --- marquee (rubber-band) selection state ---
export interface MarqueeState {
    startVb: Vec;
    currentVb: Vec;
    startClient: { x: number; y: number };
    moved: boolean;
    pointerId: number;
    /** If the marquee started on a path body, store its id for click-to-select. */
    hitPathId?: string;
}

/** Replace one item (matched by id) in a doc, sharing everything else. */
export function withItem(doc: EditableDoc, item: DocItem): EditableDoc {
    return {
        ...doc,
        items: doc.items.map((it) => (it.id === item.id ? item : it)),
    };
}

export function parseNodeKey(key: string): NodeRef {
    const [sub, idx] = key.split(":").map(Number);
    return { sub, idx };
}

// --- region hit-testing (remove-mode hover preview) -------------------------
// Hit tests come from lib/editor/hitTest, shared with the SVG editor so both
// studios agree on what a click hit.

/**
 * The d-string of the region boundary a "remove" click would dissolve at `pt`: the
 * topmost visible path item with a subpath containing the point, and within it the
 * largest containing subpath (the blob's outer loop, not a hole). null over empty
 * canvas.
 */
export function removeRegionDAt(doc: EditableDoc, pt: Vec): string | null {
    for (let i = doc.items.length - 1; i >= 0; i--) {
        const it = doc.items[i];
        if (it.kind !== "path" || !it.visible) continue;
        let bestSp: SubPath | null = null;
        let bestArea = -1;
        for (const sp of it.subPaths) {
            const poly = flattenSubPath(sp);
            if (poly.length >= 3 && pointInPolygon(pt, poly)) {
                const area = polygonArea(poly);
                if (area > bestArea) {
                    bestArea = area;
                    bestSp = sp;
                }
            }
        }
        if (bestSp) return subPathsToD([bestSp]);
    }
    return null;
}

/** The pre-merge region label under viewBox point `pt`, or null (outside / unlabelled). */
export function preMergeLabelAt(
    preMerge: PreMerge,
    pt: Vec | null,
    [vbX, vbY, vbW, vbH]: readonly [number, number, number, number],
): number | null {
    let lab: number | null = null;
    if (pt) {
        const px = Math.floor(((pt.x - vbX) / vbW) * preMerge.width);
        const py = Math.floor(((pt.y - vbY) / vbH) * preMerge.height);
        if (px >= 0 && py >= 0 && px < preMerge.width && py < preMerge.height) {
            const v = preMerge.labels[py * preMerge.width + px];
            if (v >= 0) lab = v;
        }
    }
    return lab;
}

/** Rasterize one pre-merge region to an amber (FLAT_MARKER) mask as a data URL. */
export function regionMaskUrl(preMerge: PreMerge, label: number): string | null {
    if (typeof document === "undefined") return null;
    const { labels, width, height } = preMerge;
    const cnv = document.createElement("canvas");
    cnv.width = width;
    cnv.height = height;
    const ctx = cnv.getContext("2d");
    if (!ctx) return null;
    const img = ctx.createImageData(width, height);
    const d = img.data;
    const [tr, tg, tb] = [245, 158, 11]; // amber (FLAT_MARKER)
    for (let i = 0; i < labels.length; i++) {
        if (labels[i] === label) {
            const o = i * 4;
            d[o] = tr;
            d[o + 1] = tg;
            d[o + 2] = tb;
            d[o + 3] = 255;
        }
    }
    ctx.putImageData(img, 0, 0);
    return cnv.toDataURL();
}

/** Index of the nearest marker within `radius` (viewBox units) of `pt`, or -1. */
export function markerIndexAt(
    markers: readonly RegionMarker[],
    pt: Vec,
    [vbX, vbY, vbW, vbH]: readonly [number, number, number, number],
    radius: number,
): number {
    let hit = -1;
    let bestD = radius;
    for (let i = 0; i < markers.length; i++) {
        const mx = vbX + markers[i].x * vbW;
        const my = vbY + markers[i].y * vbH;
        const d = Math.hypot(mx - pt.x, my - pt.y);
        if (d <= bestD) {
            bestD = d;
            hit = i;
        }
    }
    return hit;
}

/** Double-click hit on the selected item: the nearest anchor within `anchorR`, and
 *  whether any handle dot lies within `handleR` of `pt`. */
export function anchorHitAt(
    item: PathItem,
    pt: Vec,
    anchorR: number,
    handleR: number,
): { ref: NodeRef | null; onHandle: boolean } {
    let bestRef: NodeRef | null = null;
    let bestDist = anchorR;
    let onHandle = false;
    item.subPaths.forEach((sp, sub) =>
        sp.nodes.forEach((node, idx) => {
            const d = Math.hypot(node.x - pt.x, node.y - pt.y);
            if (d <= bestDist) {
                bestDist = d;
                bestRef = { sub, idx };
            }
            for (const h of [node.hIn, node.hOut]) {
                if (h && Math.hypot(h.x - pt.x, h.y - pt.y) <= handleR) onHandle = true;
            }
        }),
    );
    return { ref: bestRef, onHandle };
}

/** Add the 'sub:idx' key of every node of `item` inside the box to `keys`;
 *  true if any node was inside. */
export function addNodesInRect(
    item: PathItem,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    keys: Set<string>,
): boolean {
    let hasNode = false;
    item.subPaths.forEach((sp, sub) =>
        sp.nodes.forEach((node, idx) => {
            if (node.x >= x0 && node.x <= x1 && node.y >= y0 && node.y <= y1) {
                hasNode = true;
                keys.add(`${sub}:${idx}`);
            }
        }),
    );
    return hasNode;
}

/** The live-preview doc for a drag at viewBox point `pt` (cumulative from startVb). */
export function dragPreview(drag: DragState, pt: Vec): EditableDoc {
    const dx = pt.x - drag.startVb.x;
    const dy = pt.y - drag.startVb.y;
    // Planar items route every gesture through doc.topology (so the shared
    // edge's neighbour region follows live); other items edit subPaths.
    let next: EditableDoc;
    if (drag.type === "path") {
        next = drag.origItem.loops
            ? translateRegion(drag.origDoc, drag.origItem, dx, dy)
            : withItem(drag.origDoc, translateItem(drag.origItem, dx, dy));
    } else if (drag.type === "nodes") {
        next = drag.provenance
            ? translateRegionNodes(drag.origDoc, drag.provenance, drag.refs!, dx, dy)
            : withItem(drag.origDoc, moveNodes(drag.origItem, drag.refs!, dx, dy));
    } else if (drag.handleSite) {
        next = moveEdgeHandle(
            drag.origDoc,
            drag.handleSite.edgeId,
            drag.handleSite.edgeNodeIdx,
            drag.handleSite.which,
            pt,
            drag.mirror!,
        );
    } else {
        next = withItem(
            drag.origDoc,
            moveHandle(drag.origItem, drag.handleRef!, drag.which!, pt, drag.mirror!),
        );
    }
    return next;
}
