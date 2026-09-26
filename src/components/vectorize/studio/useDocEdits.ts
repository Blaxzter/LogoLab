// Edits to the traced document from the canvas, the paths list and the palette editor.

import { useCallback, type RefObject } from "react";
import { normalizeHex, rgbToHex } from "../../../lib/colorUtils";
import { isStrokeOnly } from "../../../lib/path/model";
import type { EditableDoc, PathItem } from "../../../lib/path/types";
import type { VectorizeOptions } from "../../../types";
import type { SetOpts } from "./types";

export function useDocEdits({
    doc,
    forceColorOn,
    historySet,
    dirtyRef,
    optsRef,
    docRef,
    skipRetraceRef,
    setOpts,
    selectedPathRef,
    handleSelectPath,
}: {
    doc: EditableDoc | null;
    forceColorOn: boolean;
    historySet: (next: EditableDoc, commit?: boolean) => void;
    dirtyRef: RefObject<boolean>;
    optsRef: RefObject<VectorizeOptions>;
    docRef: RefObject<EditableDoc | null>;
    skipRetraceRef: RefObject<boolean>;
    setOpts: SetOpts;
    selectedPathRef: RefObject<string | null>;
    handleSelectPath: (id: string | null) => void;
}) {
    // biome-ignore lint/correctness/useExhaustiveDependencies: dirtyRef is the studio's, stable
    const commitDoc = useCallback(
        (d: EditableDoc) => {
            historySet(d, true);
            dirtyRef.current = true;
        },
        [historySet],
    );

    // The canvas edits the force-coloured derived doc, but only its geometry.
    // Restore the base fills and gradients before storing so turning force colour
    // off never reveals baked-in overrides.
    const mergeFills = useCallback(
        (edited: EditableDoc): EditableDoc => {
            if (!forceColorOn || !doc) return edited;
            const base = new Map<string, PathItem>();
            for (const it of doc.items)
                if (it.kind === "path") base.set(it.id, it);
            return {
                ...edited,
                items: edited.items.map((it) => {
                    if (it.kind !== "path") return it;
                    const b = base.get(it.id);
                    return b
                        ? { ...it, fill: b.fill, gradient: b.gradient }
                        : it;
                }),
            };
        },
        [doc, forceColorOn],
    );

    // Lock / edit / clear the flat-art palette. An array locks it; null reverts to
    // automatic extraction. An opacity-only change can't move a region boundary, so
    // the matching paths' fill-opacity is updated live and the re-trace skipped;
    // hue / add / remove fall through to the debounced re-trace.
    // biome-ignore lint/correctness/useExhaustiveDependencies: the refs and setOpts are the studio's, stable
    const handlePaletteChange = useCallback(
        (palette: { r: number; g: number; b: number; a?: number }[] | null) => {
            const old = optsRef.current.palette ?? null;
            const cur = docRef.current;
            const rgbKey = (c: { r: number; g: number; b: number }) => `${c.r},${c.g},${c.b}`;
            const fo = (c: { a?: number }) =>
                c.a !== undefined && c.a < 255 ? c.a / 255 : undefined;
            const alphaOnly =
                !!palette &&
                !!old &&
                !!cur &&
                palette.length === old.length &&
                palette.every((c, i) => rgbKey(c) === rgbKey(old[i]));
            if (alphaOnly) {
                // Map each colour whose opacity changed → its new fill-opacity (RGB is
                // unchanged, so the swatch hex IS the path's fill).
                const remap = new Map<string, number | undefined>();
                for (let i = 0; i < palette!.length; i++) {
                    if (fo(palette![i]) !== fo(old![i])) remap.set(rgbToHex(palette![i]), fo(palette![i]));
                }
                if (remap.size > 0) {
                    historySet({
                        ...cur!,
                        items: cur!.items.map((it) => {
                            if (it.kind !== "path") return it;
                            const hex = normalizeHex(it.fill);
                            return hex && remap.has(hex) ? { ...it, fillOpacity: remap.get(hex) } : it;
                        }),
                    });
                    skipRetraceRef.current = true; // canvas already updated; no re-trace needed
                }
            }
            setOpts((o) => ({ ...o, palette: palette ?? undefined }));
        },
        [historySet],
    );

    const handleCanvasChange = useCallback(
        (d: EditableDoc) => historySet(mergeFills(d)),
        [historySet, mergeFills],
    );
    // biome-ignore lint/correctness/useExhaustiveDependencies: dirtyRef is the studio's, stable
    const handleCanvasCommit = useCallback(
        (d: EditableDoc) => {
            historySet(mergeFills(d), true);
            dirtyRef.current = true;
        },
        [historySet, mergeFills],
    );

    const handleRecolor = useCallback(
        (id: string, fill: string, commit: boolean) => {
            if (!doc) return;
            const next = {
                ...doc,
                items: doc.items.map((it) => {
                    if (it.id !== id || it.kind !== "path") return it;
                    // A stroke-only path's visible colour is its stroke; writing `fill`
                    // would do nothing.
                    if (isStrokeOnly(it)) {
                        return { ...it, stroke: { ...it.stroke!, color: fill } };
                    }
                    // Picking a solid swatch color drops any fitted gradient.
                    return { ...it, fill, gradient: undefined };
                }),
            };
            if (commit) commitDoc(next);
            else historySet(next);
        },
        [doc, commitDoc, historySet],
    );

    const handleToggleVisible = useCallback(
        (id: string) => {
            if (!doc) return;
            commitDoc({
                ...doc,
                items: doc.items.map((it) =>
                    it.id === id ? { ...it, visible: !it.visible } : it,
                ),
            });
        },
        [doc, commitDoc],
    );

    // biome-ignore lint/correctness/useExhaustiveDependencies: selectedPathRef is the studio's, stable
    const handleDeleteItem = useCallback(
        (id: string) => {
            if (!doc) return;
            commitDoc({
                ...doc,
                items: doc.items.filter((it) => it.id !== id),
            });
            if (selectedPathRef.current === id) handleSelectPath(null);
        },
        [doc, commitDoc, handleSelectPath],
    );

    return {
        commitDoc,
        handlePaletteChange,
        handleCanvasChange,
        handleCanvasCommit,
        handleRecolor,
        handleToggleVisible,
        handleDeleteItem,
    };
}
