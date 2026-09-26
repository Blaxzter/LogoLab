// Window-level keyboard shortcuts: undo/redo, tools, Escape, Delete, arrow nudges.

import { useEffect, type RefObject } from "react";
import { deleteNodes, moveNodes } from "../../../lib/path/geometry";
import { regionProvenance } from "../../../lib/path/topology";
import { deleteRegionNodes, removeRegionAndHeal, removeRegionSection, translateRegionNodes } from "../../../lib/path/topologyEdit";
import type { DocItem, EditableDoc, NodeRef, Vec } from "../../../lib/path/types";
import type { VectorizeOptions } from "../../../types";
import type { Tool } from "./types";

function parseNodeKey(key: string): NodeRef {
    const [sub, idx] = key.split(":").map(Number);
    return { sub, idx };
}

function withItem(doc: EditableDoc, item: DocItem): EditableDoc {
    return {
        ...doc,
        items: doc.items.map((it) => (it.id === item.id ? item : it)),
    };
}

export function useStudioShortcuts({
    active,
    doc,
    selectedPathId,
    selectedNodes,
    setSelectedNodes,
    seedRef,
    undo,
    redo,
    commitDoc,
    handleSelectPath,
    setTool,
    isVectorSource,
    retraceVector,
    opts,
}: {
    active: boolean;
    doc: EditableDoc | null;
    selectedPathId: string | null;
    selectedNodes: ReadonlySet<string>;
    setSelectedNodes: (keys: ReadonlySet<string>) => void;
    seedRef: RefObject<{ id: string; pt: Vec } | null>;
    undo: () => void;
    redo: () => void;
    commitDoc: (d: EditableDoc) => void;
    handleSelectPath: (id: string | null) => void;
    setTool: (t: Tool) => void;
    isVectorSource: boolean;
    retraceVector: "clean" | "retrace";
    opts: VectorizeOptions;
}) {
    // Window-level, so a studio that is mounted but not in charge must stand down,
    // or two studios would both undo on one Ctrl+Z.
    // biome-ignore lint/correctness/useExhaustiveDependencies: the setters and seedRef are the studio's, stable
    useEffect(() => {
        if (!active) return;
        const onKey = (e: KeyboardEvent) => {
            const t = e.target;
            if (
                t instanceof HTMLElement &&
                (t.isContentEditable ||
                    t.tagName === "INPUT" ||
                    t.tagName === "TEXTAREA" ||
                    t.tagName === "SELECT")
            ) {
                return;
            }
            const mod = e.ctrlKey || e.metaKey;
            const k = e.key;
            if (mod) {
                const lk = k.toLowerCase();
                if (lk === "z") {
                    e.preventDefault();
                    if (e.shiftKey) redo();
                    else undo();
                } else if (lk === "y") {
                    e.preventDefault();
                    redo();
                }
                return;
            }
            if (!e.altKey && k === "v") {
                setTool("pan");
                return;
            }
            if (!e.altKey && k === "a") {
                setTool("node");
                return;
            }
            if (!e.altKey && k === "m") {
                const colorTrace =
                    (!isVectorSource || retraceVector === "retrace") &&
                    opts.mode === "color";
                if (colorTrace) setTool("mark");
                return;
            }
            if (k === "Escape") {
                // A drag-cancel Escape is consumed by the canvas before reaching here.
                if (selectedNodes.size > 0) setSelectedNodes(new Set());
                else if (selectedPathId) handleSelectPath(null);
                return;
            }
            if (!doc) return;
            if (k === "Delete" || k === "Backspace") {
                if (!selectedPathId) return;
                const item = doc.items.find((it) => it.id === selectedPathId);
                if (!item) return;
                e.preventDefault();
                // Commit a "remove & heal" result and clear selection; drop the path
                // selection too when the whole item went away. Returns whether it
                // actually changed the doc (false ⇒ caller falls back).
                const applyHeal = (next: EditableDoc): boolean => {
                    if (next === doc) return false;
                    commitDoc(next);
                    setSelectedNodes(new Set());
                    if (!next.items.some((it) => it.id === item.id))
                        handleSelectPath(null);
                    return true;
                };
                if (item.kind === "path" && selectedNodes.size > 0) {
                    const refs = [...selectedNodes].map(parseNodeKey);
                    // Planar region: delete the underlying shared-edge nodes so the
                    // neighbour region loses them too (junctions are kept).
                    if (item.loops) {
                        const prov = regionProvenance(doc, item);
                        if (prov) {
                            const next = deleteRegionNodes(doc, prov, refs);
                            if (next !== doc) {
                                commitDoc(next);
                                setSelectedNodes(new Set());
                                return;
                            }
                            // Nothing thinnable (the selection is a blob's junctions, which can't
                            // be deleted without unwelding the graph): dissolve that blob and heal
                            // it instead. The selected nodes' subpath index is the loop.
                            const sub = refs[0]?.sub ?? 0;
                            if (applyHeal(removeRegionSection(doc, item.id, sub)))
                                return;
                            // Still nothing actionable — leave the doc untouched.
                            setSelectedNodes(new Set());
                            return;
                        }
                    }
                    const next = deleteNodes(item, refs);
                    if (next) {
                        commitDoc(withItem(doc, next));
                        setSelectedNodes(new Set());
                    } else {
                        // Nothing drawable left — the whole path goes.
                        commitDoc({
                            ...doc,
                            items: doc.items.filter((it) => it.id !== item.id),
                        });
                        setSelectedNodes(new Set());
                        handleSelectPath(null);
                    }
                } else {
                    // Planar region, no nodes selected: dissolve the one section the user
                    // clicked and heal the gap into its neighbour, instead of deleting every
                    // blob of that colour. Needs the seed from the selecting click; falls back
                    // to deleting the whole item when the region is non-planar or the seed is
                    // stale.
                    const seed =
                        seedRef.current?.id === item.id
                            ? seedRef.current.pt
                            : null;
                    if (
                        item.kind === "path" &&
                        item.loops &&
                        seed &&
                        applyHeal(removeRegionAndHeal(doc, item.id, seed))
                    )
                        return;
                    commitDoc({
                        ...doc,
                        items: doc.items.filter((it) => it.id !== item.id),
                    });
                    setSelectedNodes(new Set());
                    handleSelectPath(null);
                }
                return;
            }
            if (
                (k === "ArrowLeft" ||
                    k === "ArrowRight" ||
                    k === "ArrowUp" ||
                    k === "ArrowDown") &&
                selectedPathId &&
                selectedNodes.size > 0
            ) {
                const item = doc.items.find((it) => it.id === selectedPathId);
                if (!item || item.kind !== "path") return;
                e.preventDefault();
                const step = (doc.viewBox[2] / 1024) * (e.shiftKey ? 10 : 1);
                const dx =
                    k === "ArrowLeft" ? -step : k === "ArrowRight" ? step : 0;
                const dy =
                    k === "ArrowUp" ? -step : k === "ArrowDown" ? step : 0;
                const refs = [...selectedNodes].map(parseNodeKey);
                // Planar region: nudge through the graph so junctions drag every
                // incident spoke and shared edges keep the neighbour coincident.
                if (item.loops) {
                    const prov = regionProvenance(doc, item);
                    if (prov) {
                        commitDoc(translateRegionNodes(doc, prov, refs, dx, dy));
                        return;
                    }
                }
                commitDoc(withItem(doc, moveNodes(item, refs, dx, dy)));
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [
        active,
        doc,
        selectedPathId,
        selectedNodes,
        undo,
        redo,
        commitDoc,
        handleSelectPath,
        isVectorSource,
        retraceVector,
        opts.mode,
    ]);
}
