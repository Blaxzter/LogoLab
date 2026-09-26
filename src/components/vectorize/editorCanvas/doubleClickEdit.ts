// Double-click edits on the node-edit canvas: toggle an anchor's kind or insert a node.

import type { EditableDoc, NodeRef, PathItem, Vec } from "../../../lib/path/types";
import { insertNode, nearestPointOnItem, setNodeKind } from "../../../lib/path/geometry";
import { regionProvenance } from "../../../lib/path/topology";
import { insertNodeOnEdge, resolveEdgeSegment, setEdgeNodeKind } from "../../../lib/path/topologyEdit";
import { ANCHOR_HIT_PX, HANDLE_HIT_PX, HIT, INSERT_MAX_PX } from "./constants";
import { anchorHitAt, withItem } from "./geometry";

export interface DoubleClickContext {
    marking: boolean;
    interactive: boolean;
    doc: EditableDoc;
    selectedItem: PathItem | null;
    toVb: (clientX: number, clientY: number) => Vec | null;
    liveScale: () => number;
    onSelectPath: (id: string | null) => void;
    onSelectNodes: (keys: Set<string>) => void;
    onDocCommit: (doc: EditableDoc) => void;
}

// One double-click handler on the svg root, hit-testing geometrically rather
// than by DOM target (handle dots sit almost on the curve, so the target is
// ambiguous). Priorities: anchor (toggle kind) →
// handle dot (swallow) → segment (insert node) → painted fill (swallow) →
// background (fall through to ZoomSurface's zoom reset).
export function doubleClickEdit(e: React.MouseEvent<SVGSVGElement>, ctx: DoubleClickContext): void {
    const { doc, selectedItem, onSelectPath, onSelectNodes, onDocCommit } = ctx;
    // In mark mode the svg receives events, so swallow the dblclick to stop
    // ZoomSurface from resetting the zoom while the user is placing markers.
    if (ctx.marking) {
        e.stopPropagation();
        return;
    }
    if (!ctx.interactive) return;
    const pt = ctx.toVb(e.clientX, e.clientY);
    if (!pt) return;
    const scale = ctx.liveScale();

    if (selectedItem) {
        // 1) Anchor: toggle corner ↔ smooth.
        const { ref: bestRef, onHandle } = anchorHitAt(
            selectedItem,
            pt,
            (ANCHOR_HIT_PX * HIT) / scale,
            (HANDLE_HIT_PX * HIT) / scale,
        );
        if (bestRef) {
            e.stopPropagation();
            const ref: NodeRef = bestRef;
            const node = selectedItem.subPaths[ref.sub].nodes[ref.idx];
            const kind = node.kind === "smooth" ? "corner" : "smooth";
            // Planar: toggle the shared edge node's kind so both regions update.
            if (selectedItem.loops) {
                const pv = regionProvenance(doc, selectedItem)?.[ref.sub]?.[ref.idx];
                if (pv) {
                    onDocCommit(setEdgeNodeKind(doc, pv.edgeId, pv.edgeNodeIdx, kind));
                    return;
                }
            }
            onDocCommit(withItem(doc, setNodeKind(selectedItem, ref, kind)));
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
    const tolerance = (INSERT_MAX_PX * HIT) / scale;
    const candidates: PathItem[] = [];
    if (selectedItem) candidates.push(selectedItem);
    for (let i = doc.items.length - 1; i >= 0; i--) {
        const it = doc.items[i];
        if (it.kind === "path" && it.visible && it !== selectedItem) candidates.push(it);
    }
    for (const item of candidates) {
        const hit = nearestPointOnItem(item, pt);
        if (!hit || hit.dist > tolerance) continue;
        e.stopPropagation();
        // Planar: split the underlying shared edge so both regions gain the node.
        if (item.loops) {
            const prov = regionProvenance(doc, item);
            const subLen = item.subPaths[hit.sub]?.nodes.length ?? 0;
            const seg = prov ? resolveEdgeSegment(prov, hit.sub, hit.seg, subLen, hit.t) : null;
            if (!seg) return;
            const next = insertNodeOnEdge(doc, seg.edgeId, seg.segIdx, seg.t);
            if (next === doc) return;
            onSelectPath(item.id);
            onSelectNodes(new Set([`${hit.sub}:${hit.seg + 1}`]));
            onDocCommit(next);
            return;
        }
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
}
