// Geometry for the node-edit overlay, batched into one path string per style.
//
// Per-node SVG elements don't scale: a traced page can have thousands of nodes,
// and every element re-renders on pan and zoom (marker radii are constant in
// screen px). Batching keeps the overlay to a few elements. Grabbing uses a
// nearest-point test (`nearestGrab`) instead of DOM hit targets.
//
// Plain .ts, not .tsx, so tests can import it.

import type { PathItem, Vec } from "../../lib/path/types";

/** 3 decimals: sub-pixel at the studio's 32× max zoom on any sane viewBox. */
const f = (v: number) => String(Math.round(v * 1000) / 1000);

/** Node keys ('sub:idx') to draw; undefined ⇒ every node. */
type KeyFilter = ReadonlySet<string> | undefined;

/** Anchor marks: smooth nodes as circles (radius `rs`), corners as squares (half-side `rc`). */
export function anchorMarksD(
    item: PathItem,
    rs: number,
    rc: number,
    only?: KeyFilter,
): { smooth: string; corner: string } {
    const smooth: string[] = [];
    const corner: string[] = [];
    item.subPaths.forEach((sp, sub) =>
        sp.nodes.forEach((n, idx) => {
            if (only && !only.has(`${sub}:${idx}`)) return;
            if (n.kind === "smooth") smooth.push(circleD(n.x, n.y, rs));
            else
                corner.push(
                    `M${f(n.x - rc)} ${f(n.y - rc)}h${f(2 * rc)}v${f(2 * rc)}h${f(-2 * rc)}z`,
                );
        }),
    );
    return { smooth: smooth.join(""), corner: corner.join("") };
}

/** Anchor → handle spokes. Scale-free, so it only changes with the item. */
export function spokesD(item: PathItem): string {
    const out: string[] = [];
    for (const sp of item.subPaths)
        for (const n of sp.nodes) {
            if (n.hIn) out.push(`M${f(n.x)} ${f(n.y)}L${f(n.hIn.x)} ${f(n.hIn.y)}`);
            if (n.hOut) out.push(`M${f(n.x)} ${f(n.y)}L${f(n.hOut.x)} ${f(n.hOut.y)}`);
        }
    return out.join("");
}

/** Every handle dot as a circle of radius `r`. */
export function handleDotsD(item: PathItem, r: number): string {
    const out: string[] = [];
    for (const sp of item.subPaths)
        for (const n of sp.nodes) {
            if (n.hIn) out.push(circleD(n.hIn.x, n.hIn.y, r));
            if (n.hOut) out.push(circleD(n.hOut.x, n.hOut.y, r));
        }
    return out.join("");
}

export function circleD(x: number, y: number, r: number): string {
    return `M${f(x - r)} ${f(y)}a${f(r)} ${f(r)} 0 1 0 ${f(2 * r)} 0a${f(r)} ${f(r)} 0 1 0 ${f(-2 * r)} 0z`;
}

/**
 * The grab target under `pt`: an anchor ('sub:idx') or a handle dot
 * ('sub:idx:in' | 'sub:idx:out') within `radius`, nearest first. On a tie the
 * anchor wins — a smooth node's handle can sit almost on top of it, and the
 * anchor is the thing people reach for.
 */
export function nearestGrab(item: PathItem, pt: Vec, radius: number): string | null {
    let best: string | null = null;
    let bestD = radius * radius;
    let bestIsAnchor = false;
    const consider = (x: number, y: number, key: string, anchor: boolean) => {
        const dx = x - pt.x;
        const dy = y - pt.y;
        const d = dx * dx + dy * dy;
        if (d < bestD || (d === bestD && anchor && !bestIsAnchor) || (d <= bestD && best === null)) {
            bestD = d;
            best = key;
            bestIsAnchor = anchor;
        }
    };
    item.subPaths.forEach((sp, sub) =>
        sp.nodes.forEach((n, idx) => {
            if (n.hIn) consider(n.hIn.x, n.hIn.y, `${sub}:${idx}:in`, false);
            if (n.hOut) consider(n.hOut.x, n.hOut.y, `${sub}:${idx}:out`, false);
            consider(n.x, n.y, `${sub}:${idx}`, true);
        }),
    );
    return best;
}
