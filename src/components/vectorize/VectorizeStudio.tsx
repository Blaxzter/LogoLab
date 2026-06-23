// The vectorize studio: a full-height workspace wiring the trace engine to an
// editable vector document. Left rail = trace parameters, center = toolbar +
// pan/zoom stage (split / traced / original / overlay views) + status bar,
// right rail = per-path list. The traced doc lives in undo/redo history; node
// edits flow back from the canvas as live previews + committed steps.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    Check,
    Copy,
    Download,
    Hand,
    Layers,
    Loader2,
    MapPin,
    MousePointer2,
    Redo2,
    SlidersHorizontal,
    Undo2,
} from "lucide-react";
import { useCheckerClass, useLogo, useStore } from "../../store";
import { usePanZoom, type PanZoom } from "../../hooks/usePanZoom";
import { useHistory } from "../../hooks/useHistory";
import { ZoomSurface } from "../ui/ZoomSurface";
import { ZoomControls } from "../ui/ZoomControls";
import { CheckerToggle } from "../ui/CheckerToggle";
import { Segmented } from "../ui/controls";
import { Button } from "../ui/Button";
import { getImageData } from "../../lib/image";
import { downloadText } from "../../lib/download";
import { cleanSvg } from "../../lib/svgClean";
import { docStats, parseSvg, serializeDoc } from "../../lib/path/model";
import { deleteNodes, moveNodes } from "../../lib/path/geometry";
import { regionProvenance } from "../../lib/path/topology";
import { deleteRegionNodes, translateRegionNodes } from "../../lib/path/topologyEdit";
import { DEFAULT_VECTORIZE_OPTIONS, traceImage } from "../../lib/trace";
import { traceImageOffThread, canTraceOffThread } from "../../lib/trace/traceOffThread";
import type { VectorizeOptions } from "../../types";
import type { DocItem, EditableDoc, NodeRef, PathItem } from "../../lib/path/types";
import { TraceControls, TraceControlsBody } from "./TraceControls";
import { EditorCanvas, useFitBox } from "./EditorCanvas";
import { PathsPanel, PathsPanelBody } from "./PathsPanel";
import { PipelineExplainer } from "./PipelineExplainer";
import { Sheet } from "../ui/Sheet";
import { PopoverSlider } from "../ui/PopoverSlider";
import { StudioTopBar, StudioActionBar, BarIconButton } from "../studio/StudioBar";
import { LegalLinksInline } from "../legal/LegalFooter";
import { Tooltip } from "../ui/Tooltip";
import { useIsMobile } from "../../hooks/useIsMobile";

const RASTER_MAX_DIM = 1024;
const DEBOUNCE_MS = 400;

type ViewMode = "split" | "traced" | "original" | "overlay";
type Tool = "pan" | "node" | "mark";

/** Human-readable byte size ('842 B' / '12.4 KB' / '1.20 MB'). */
function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const kb = bytes / 1024;
    if (kb < 1024) return `${kb.toFixed(kb < 10 ? 2 : 1)} KB`;
    return `${(kb / 1024).toFixed(2)} MB`;
}

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

export function VectorizeStudio() {
    const logo = useLogo();
    const checkerClass = useCheckerClass();
    const setProcessedSvg = useStore((s) => s.setProcessedSvg);
    const pz = usePanZoom({ maxScale: 32 });
    const isMobile = useIsMobile();

    const [opts, setOpts] = useState<VectorizeOptions>(
        DEFAULT_VECTORIZE_OPTIONS,
    );
    // Output coordinate precision (decimals). Fixed default — compact files at no
    // visible cost; no longer a user knob (it was output formatting, not a trace
    // parameter, and cluttered the panel).
    const precision = 2;
    const [forceColorOn, setForceColorOn] = useState(false);
    const [forceColor, setForceColor] = useState("#14161c");
    const [showHelp, setShowHelp] = useState(false);
    const [retraceVector, setRetraceVector] = useState<"clean" | "retrace">(
        "clean",
    );
    const [viewMode, setViewMode] = useState<ViewMode>("split");
    const [tool, setTool] = useState<Tool>("pan");
    // Below md the rails live in bottom sheets opened from the action bar.
    const [traceSheetOpen, setTraceSheetOpen] = useState(false);
    const [pathsSheetOpen, setPathsSheetOpen] = useState(false);
    const [overlayOpacity, setOverlayOpacity] = useState(60);
    // Region markers have no separate "enable" switch: the markers ARE the feature.
    // With none placed the trace is byte-identical; placing one turns it on. The only
    // transient state is "region mode" (tool === 'mark') — click-to-place vs pan.

    const history = useHistory<EditableDoc>();
    const doc = history.value;
    const {
        set: historySet,
        reset: historyReset,
        undo,
        redo,
        canUndo,
        canRedo,
    } = history;

    const [selectedPathId, setSelectedPathId] = useState<string | null>(null);
    const [selectedNodes, setSelectedNodes] = useState<ReadonlySet<string>>(
        () => new Set(),
    );
    // Manual edits win over the auto-run: while dirty, parameter changes only
    // arm the "re-trace discards edits" notice instead of re-tracing.
    const dirtyRef = useRef(false);
    const [staleEdits, setStaleEdits] = useState(false);

    const [busy, setBusy] = useState(false);
    const [progress, setProgress] = useState("");
    // Pre-merge region map (fine regions before the gradient field-merge) from the
    // last trace — drives the region hover-highlight while placing markers.
    const [preMerge, setPreMerge] = useState<{ labels: Int32Array; width: number; height: number } | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);
    const [applied, setApplied] = useState(false);
    const runIdRef = useRef(0);
    const abortRef = useRef<AbortController | null>(null);

    const isVectorSource = logo.isSvg && Boolean(logo.svgText);
    const cleanFromExisting = isVectorSource && retraceVector === "clean";
    // Precision only re-runs the pipeline in clean mode (cleanSvg rounds the
    // markup); in trace mode it is applied at serialize time.
    const cleanPrecision = cleanFromExisting ? precision : -1;

    /* ----------------------------------------------------------- selection */

    // Mirror of selectedPathId so selection callbacks stay referentially stable.
    const selectedPathRef = useRef<string | null>(null);

    const handleSelectPath = useCallback((id: string | null) => {
        if (selectedPathRef.current !== id) setSelectedNodes(new Set());
        selectedPathRef.current = id;
        setSelectedPathId(id);
    }, []);

    const handleSelectNodes = useCallback(
        (keys: Set<string>) => setSelectedNodes(keys),
        [],
    );

    /* ------------------------------------------------------------ doc flow */

    const commitDoc = useCallback(
        (d: EditableDoc) => {
            historySet(d, true);
            dirtyRef.current = true;
        },
        [historySet],
    );

    // The canvas renders (and edits) the force-colored derived doc, but only
    // ever changes geometry/structure — restore the base fills (and gradients)
    // before storing, so toggling force color off never reveals baked-in
    // overrides or drops a fitted gradient.
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

    /* ------------------------------------------------------- region markers */

    // Markers (segmentation seeds) live in `opts.markers` so they flow straight
    // into the trace and the explainer, survive a re-trace (run() only resets the
    // doc, never opts), and serialize through the worker unchanged. Normalized
    // [0,1] coords ⇒ resolution-independent.
    const markers = useMemo(() => opts.markers ?? [], [opts.markers]);

    // Which kind of marker a click drops: "separate" (keep the region distinct, its
    // paint untouched), "flat" (also pin it to its pre-merge flat form + solid), or
    // "remove" (dissolve the section and heal its neighbours into the gap).
    const [markMode, setMarkMode] = useState<"separate" | "flat" | "remove">(
        "separate",
    );

    const addMarker = useCallback(
        (x: number, y: number) => {
            const m =
                markMode === "flat"
                    ? { x, y, flat: true }
                    : markMode === "remove"
                      ? { x, y, remove: true }
                      : { x, y };
            setOpts((o) => ({ ...o, markers: [...(o.markers ?? []), m] }));
        },
        [markMode],
    );
    const removeMarker = useCallback((index: number) => {
        setOpts((o) => ({
            ...o,
            markers: (o.markers ?? []).filter((_, i) => i !== index),
        }));
    }, []);
    const clearMarkers = useCallback(() => {
        setTool("pan");
        setOpts((o) => (o.markers && o.markers.length ? { ...o, markers: [] } : o));
    }, []);

    // Region markers only apply to colour tracing — leaving that mode exits the
    // placement tool (the master switch + markers persist for when you return).
    useEffect(() => {
        const colorTrace =
            (!isVectorSource || retraceVector === "retrace") &&
            opts.mode === "color";
        if (!colorTrace && tool === "mark") setTool("pan");
    }, [isVectorSource, retraceVector, opts.mode, tool]);

    const handleCanvasChange = useCallback(
        (d: EditableDoc) => historySet(mergeFills(d)),
        [historySet, mergeFills],
    );
    const handleCanvasCommit = useCallback(
        (d: EditableDoc) => {
            historySet(mergeFills(d), true);
            dirtyRef.current = true;
        },
        [historySet, mergeFills],
    );

    /* ------------------------------------------------------------ trace run */

    const run = useCallback(async () => {
        if (!logo.src) return;
        const runId = ++runIdRef.current;
        abortRef.current?.abort();
        const controller = new AbortController();
        abortRef.current = controller;
        setBusy(true);
        setError(null);
        setProgress(cleanFromExisting ? "Cleaning SVG…" : "Tracing…");
        try {
            let next: EditableDoc | null;
            if (cleanFromExisting && logo.svgText) {
                // Yield a macrotask so the busy state paints before the sync clean.
                await new Promise((r) => setTimeout(r));
                if (runId !== runIdRef.current) return;
                const cleaned = cleanSvg(logo.svgText, {
                    precision,
                    stripDimensions: true,
                    // Force color is applied at render/serialize time, not baked here.
                    forceFill: null,
                    removeBackground: opts.removeBackground,
                });
                next = parseSvg(cleaned.svg);
                if (!next) throw new Error("SVG could not be parsed");
            } else {
                const imageData = await getImageData(
                    logo.src,
                    RASTER_MAX_DIM,
                    logo.isSvg ? logo.svgText : null,
                );
                if (runId !== runIdRef.current) return;
                // Crisp runs in a Web Worker (pure JS) so the UI stays responsive;
                // potrace stays on the main thread (its WASM wrapper needs DOMParser).
                const runTrace = canTraceOffThread(opts) ? traceImageOffThread : traceImage;
                next = await runTrace(
                    imageData,
                    opts,
                    (p) => {
                        if (runId !== runIdRef.current) return;
                        setProgress(
                            p.phase === "quantize"
                                ? "Analyzing colors…"
                                : `Tracing layer ${p.layer}/${p.total}…`,
                        );
                    },
                    controller.signal,
                    (pm) => {
                        if (runId === runIdRef.current) setPreMerge(pm);
                    },
                );
            }
            if (runId !== runIdRef.current) return;
            historyReset(next);
            handleSelectPath(null);
            setSelectedNodes(new Set());
            dirtyRef.current = false;
            setStaleEdits(false);
        } catch (err) {
            if (err instanceof DOMException && err.name === "AbortError")
                return;
            if (runId === runIdRef.current) {
                setError(
                    "Could not vectorize this image — try different settings or another file.",
                );
            }
        } finally {
            if (runId === runIdRef.current) {
                setBusy(false);
                setProgress("");
            }
        }
    }, [
        logo.src,
        logo.isSvg,
        logo.svgText,
        opts,
        cleanFromExisting,
        cleanPrecision,
        historyReset,
        handleSelectPath,
    ]);

    // Auto-run (debounced) whenever the source or parameters change — unless
    // the user has hand-edited paths, in which case their edits win.
    useEffect(() => {
        if (dirtyRef.current) {
            setStaleEdits(true);
            return;
        }
        const id = window.setTimeout(() => void run(), DEBOUNCE_MS);
        return () => window.clearTimeout(id);
    }, [run]);

    useEffect(() => () => abortRef.current?.abort(), []);

    /* ------------------------------------------------------------- derived */

    const derivedDoc = useMemo(() => {
        if (!doc) return null;
        if (!forceColorOn) return doc;
        return {
            ...doc,
            items: doc.items.map((it) =>
                it.kind === "path"
                    ? { ...it, fill: forceColor, gradient: undefined }
                    : it,
            ),
        };
    }, [doc, forceColorOn, forceColor]);

    const svgText = useMemo(
        () => (derivedDoc ? serializeDoc(derivedDoc, precision) : null),
        [derivedDoc, precision],
    );
    const svgBytes = useMemo(
        () => (svgText ? new TextEncoder().encode(svgText).length : 0),
        [svgText],
    );
    const stats = useMemo(
        () => (derivedDoc ? docStats(derivedDoc) : null),
        [derivedDoc],
    );

    // Reset the "Applied" badge whenever the output changes.
    useEffect(() => {
        setApplied(false);
    }, [svgText]);

    // The Paths sheet is gated on `derivedDoc`; if the doc ever clears, drop the
    // open flag so the sheet can't silently re-open when a doc returns.
    useEffect(() => {
        if (!derivedDoc) setPathsSheetOpen(false);
    }, [derivedDoc]);

    /* ------------------------------------------------------------ keyboard */

    useEffect(() => {
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
                if (item.kind === "path" && selectedNodes.size > 0) {
                    const refs = [...selectedNodes].map(parseNodeKey);
                    // Planar region: delete the underlying shared-edge nodes so the
                    // neighbour region loses them too (junctions are kept).
                    if (item.loops) {
                        const prov = regionProvenance(doc, item);
                        if (prov) {
                            const next = deleteRegionNodes(doc, prov, refs);
                            if (next !== doc) commitDoc(next);
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

    /* ---------------------------------------------------------- panel edits */

    const handleRecolor = useCallback(
        (id: string, fill: string, commit: boolean) => {
            if (!doc) return;
            // Picking a solid swatch color drops any fitted gradient.
            const next = {
                ...doc,
                items: doc.items.map((it) =>
                    it.id === id && it.kind === "path"
                        ? { ...it, fill, gradient: undefined }
                        : it,
                ),
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

    /* -------------------------------------------------------------- export */

    const onDownload = () => {
        if (!svgText) return;
        const base =
            (logo.fileName?.replace(/\.[^.]+$/, "") || "logo").trim() || "logo";
        downloadText(svgText, `${base}.svg`, "image/svg+xml");
    };

    const onApply = () => {
        if (!svgText || !derivedDoc) return;
        const [, , w, h] = derivedDoc.viewBox;
        setProcessedSvg(svgText, w, h);
        setApplied(true);
    };

    const onCopy = async () => {
        if (!svgText) return;
        try {
            await navigator.clipboard.writeText(svgText);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
        } catch {
            setError("Clipboard copy was blocked by the browser.");
        }
    };

    /* -------------------------------------------------------------- render */

    if (!logo.src) return null;

    const canvasShared = {
        pz,
        tool,
        editable: !busy,
        selectedPathId,
        selectedNodes,
        markers,
        markMode,
        preMerge,
        onSelectPath: handleSelectPath,
        onSelectNodes: handleSelectNodes,
        onDocChange: handleCanvasChange,
        onDocCommit: handleCanvasCommit,
        onAddMarker: addMarker,
        onRemoveMarker: removeMarker,
    };

    // Below md the desktop-only split pane is too narrow — default to the single
    // traced pane (the mobile view-mode strip omits "split").
    const view: ViewMode = isMobile && viewMode === "split" ? "traced" : viewMode;

    // One prop bag feeds both the desktop rail and the mobile Trace sheet.
    const traceProps = {
        isVectorSource,
        source: retraceVector,
        onSourceChange: setRetraceVector,
        opts,
        onPatch: (p: Partial<VectorizeOptions>) => setOpts((o) => ({ ...o, ...p })),
        forceColorOn,
        onForceColorOn: setForceColorOn,
        forceColor,
        onForceColor: setForceColor,
        marking: tool === "mark",
        onMarkingChange: (on: boolean) => setTool(on ? "mark" : "pan"),
        markerCount: markers.length,
        flatCount: markers.filter((m) => m.flat).length,
        removeCount: markers.filter((m) => m.remove).length,
        markMode,
        onMarkModeChange: setMarkMode,
        onClearMarkers: clearMarkers,
        busy,
        staleEdits,
        onTrace: () => {
            setTraceSheetOpen(false);
            void run();
        },
        onShowHelp: () => {
            setTraceSheetOpen(false);
            setShowHelp(true);
        },
    };

    return (
        <div className="flex h-full min-h-0 shrink-0 animate-in-fade">
            <TraceControls {...traceProps} />

            <div className="flex min-w-0 flex-1 flex-col">
                {/* ------------------------------------------ toolbar (desktop) */}
                <div className="hidden h-12 shrink-0 items-center gap-2 border-b border-line bg-surface px-3 md:flex">
                    <Segmented<ViewMode>
                        value={viewMode}
                        onChange={setViewMode}
                        options={[
                            { value: "split", label: "Split" },
                            { value: "traced", label: "Traced" },
                            { value: "original", label: "Original" },
                            { value: "overlay", label: "Overlay" },
                        ]}
                    />
                    <div
                        className={
                            viewMode === "original"
                                ? "pointer-events-none opacity-50"
                                : ""
                        }
                    >
                        <Segmented<Tool>
                            value={tool}
                            onChange={setTool}
                            options={[
                                {
                                    value: "pan",
                                    title: "Pan & zoom (V)",
                                    label: (
                                        <>
                                            <Hand size={13} /> Pan
                                        </>
                                    ),
                                },
                                {
                                    value: "node",
                                    title: "Edit nodes (A)",
                                    label: (
                                        <>
                                            <MousePointer2 size={13} /> Edit
                                        </>
                                    ),
                                },
                            ]}
                        />
                    </div>
                    {opts.mode === "color" &&
                        (!isVectorSource || retraceVector === "retrace") &&
                        markers.length > 0 && (
                            <span className="flex items-center gap-1.5 text-xs text-muted tabular-nums">
                                <MapPin size={12} className="text-emerald-500" />
                                {markers.length} marker
                                {markers.length === 1 ? "" : "s"}
                            </span>
                        )}
                    <ToolButton
                        title="Undo (Ctrl+Z)"
                        onClick={undo}
                        disabled={!canUndo}
                    >
                        <Undo2 size={15} />
                    </ToolButton>
                    <ToolButton
                        title="Redo (Ctrl+Shift+Z)"
                        onClick={redo}
                        disabled={!canRedo}
                    >
                        <Redo2 size={15} />
                    </ToolButton>
                    {viewMode === "overlay" && (
                        <label className="flex items-center gap-2 text-xs text-muted">
                            Ghost
                            <input
                                type="range"
                                min={0}
                                max={100}
                                value={overlayOpacity}
                                onChange={(e) =>
                                    setOverlayOpacity(Number(e.target.value))
                                }
                                className="h-1.5 w-28 cursor-pointer appearance-none rounded-full bg-line-strong"
                            />
                        </label>
                    )}
                    <div className="ml-auto flex items-center gap-2">
                        <ZoomControls pz={pz} />
                        <CheckerToggle />
                        <span className="h-5 w-px bg-line" aria-hidden />
                        <Button
                            variant="primary"
                            className="h-8 px-3 text-xs"
                            icon={applied ? <Check size={14} /> : undefined}
                            onClick={onApply}
                            disabled={!svgText}
                        >
                            {applied ? "Applied \u2713" : "Apply to logo"}
                        </Button>
                        <Button
                            variant="secondary"
                            className="h-8 px-3 text-xs"
                            icon={<Download size={14} />}
                            onClick={onDownload}
                            disabled={!svgText}
                        >
                            Download SVG
                        </Button>
                        <Button
                            variant="secondary"
                            className="h-8 px-3 text-xs"
                            icon={
                                copied ? (
                                    <Check size={14} />
                                ) : (
                                    <Copy size={14} />
                                )
                            }
                            onClick={() => void onCopy()}
                            disabled={!svgText}
                        >
                            {copied ? "Copied" : "Copy"}
                        </Button>
                    </div>
                </div>

                {/* ------------------------------------------- top strip (mobile) */}
                <StudioTopBar>
                    <Segmented<ViewMode>
                        value={view}
                        onChange={setViewMode}
                        options={[
                            { value: "traced", label: "Traced" },
                            { value: "original", label: "Original" },
                            { value: "overlay", label: "Overlay" },
                        ]}
                    />
                    <div className={view === "original" ? "pointer-events-none opacity-50" : ""}>
                        <Segmented<Tool>
                            value={tool === "mark" ? "pan" : tool}
                            onChange={setTool}
                            options={[
                                {
                                    value: "pan",
                                    title: "Pan & zoom",
                                    label: (
                                        <>
                                            <Hand size={13} /> Pan
                                        </>
                                    ),
                                },
                                {
                                    value: "node",
                                    title: "Edit nodes",
                                    label: (
                                        <>
                                            <MousePointer2 size={13} /> Edit
                                        </>
                                    ),
                                },
                            ]}
                        />
                    </div>
                    <BarIconButton title="Undo" onClick={undo} disabled={!canUndo}>
                        <Undo2 size={17} />
                    </BarIconButton>
                    <BarIconButton title="Redo" onClick={redo} disabled={!canRedo}>
                        <Redo2 size={17} />
                    </BarIconButton>
                    {view === "overlay" && (
                        <PopoverSlider
                            title="Ghost opacity"
                            value={overlayOpacity}
                            min={0}
                            max={100}
                            onChange={setOverlayOpacity}
                            valueText={`${overlayOpacity}%`}
                            placement="bottom"
                            className="shrink-0"
                        >
                            Ghost
                        </PopoverSlider>
                    )}
                    <div className="ml-auto flex shrink-0 items-center gap-1.5 pl-1">
                        <ZoomControls pz={pz} />
                        <BarIconButton title="Copy SVG" onClick={() => void onCopy()} disabled={!svgText}>
                            {copied ? <Check size={17} /> : <Copy size={17} />}
                        </BarIconButton>
                        <BarIconButton title="Download SVG" onClick={onDownload} disabled={!svgText}>
                            <Download size={17} />
                        </BarIconButton>
                    </div>
                </StudioTopBar>

                {/* -------------------------------------------------------- stage */}
                <div
                    className={`relative min-h-0 flex-1 ${checkerClass} ${
                        tool === "mark"
                            ? "ring-2 ring-inset ring-emerald-400/70"
                            : ""
                    }`}
                >
                    {view === "split" && (
                        <div className="grid h-full grid-cols-2">
                            <div className="relative h-full min-w-0 border-r border-line">
                                <OriginalPane
                                    pz={pz}
                                    src={logo.src}
                                    aspectW={logo.naturalWidth || 1}
                                    aspectH={logo.naturalHeight || 1}
                                    primary
                                    markers={markers}
                                    marking={tool === "mark"}
                                    onAddMarker={addMarker}
                                    onRemoveMarker={removeMarker}
                                />
                                <Chip>Original</Chip>
                            </div>
                            <div className="relative h-full min-w-0">
                                {derivedDoc ? (
                                    <EditorCanvas
                                        {...canvasShared}
                                        doc={derivedDoc}
                                    />
                                ) : (
                                    <StagePlaceholder busy={busy} />
                                )}
                                <Chip>Traced</Chip>
                            </div>
                        </div>
                    )}
                    {view === "traced" &&
                        (derivedDoc ? (
                            <EditorCanvas
                                {...canvasShared}
                                doc={derivedDoc}
                                primary
                            />
                        ) : (
                            <StagePlaceholder busy={busy} />
                        ))}
                    {view === "original" && (
                        <OriginalPane
                            pz={pz}
                            src={logo.src}
                            aspectW={logo.naturalWidth || 1}
                            aspectH={logo.naturalHeight || 1}
                            primary
                            markers={markers}
                            marking={tool === "mark"}
                            onAddMarker={addMarker}
                            onRemoveMarker={removeMarker}
                        />
                    )}
                    {view === "overlay" &&
                        (derivedDoc ? (
                            <EditorCanvas
                                {...canvasShared}
                                doc={derivedDoc}
                                primary
                                underlay={{
                                    src: logo.src,
                                    opacity: overlayOpacity / 100,
                                }}
                            />
                        ) : (
                            <StagePlaceholder busy={busy} />
                        ))}

                    {/* Trace-in-progress overlay: a sweeping band + a status pill.
                        pointer-events-none so panning/zooming stays live (the crisp
                        trace runs off-thread) and the CSS sweep stays smooth. */}
                    {busy && (
                        <div className="animate-in-fade pointer-events-none absolute inset-0 overflow-hidden">
                            <div className="trace-sweep" />
                            <div className="absolute left-1/2 top-3 -translate-x-1/2">
                                <span className="flex items-center gap-2 rounded-full border border-line bg-surface/90 px-3 py-1 text-xs font-medium text-accent shadow-sm backdrop-blur">
                                    <Loader2 size={13} className="animate-spin" />
                                    {progress || "Tracing…"}
                                </span>
                            </div>
                        </div>
                    )}

                    {/* Marking-active cue: marking is armed from the sidebar, so this
                        on-stage banner makes it obvious the canvas is now clickable. */}
                    {tool === "mark" && !busy && (
                        <div className="animate-in-fade pointer-events-none absolute left-1/2 top-3 z-10 -translate-x-1/2">
                            <span
                                className={`flex items-center gap-2 rounded-full border bg-surface/90 px-3 py-1 text-xs font-medium shadow-sm backdrop-blur ${
                                    markMode === "flat"
                                        ? "border-amber-400/50 text-amber-600 dark:text-amber-400"
                                        : markMode === "remove"
                                          ? "border-rose-400/50 text-rose-600 dark:text-rose-400"
                                          : "border-emerald-400/50 text-emerald-600 dark:text-emerald-400"
                                }`}
                            >
                                <MapPin size={13} />
                                {markMode === "flat"
                                    ? "Click a region to paint it one flat colour"
                                    : markMode === "remove"
                                      ? "Click a section to remove it and heal the neighbours in"
                                      : "Click a region to keep it as its own shape"}
                                <button
                                    type="button"
                                    onClick={() => setTool("pan")}
                                    className="pointer-events-auto -mr-1 ml-1 rounded-full px-2 py-0.5 text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink"
                                >
                                    Done
                                </button>
                            </span>
                        </div>
                    )}
                </div>

                {/* ------------------------------------------ status bar (desktop) */}
                <footer className="hidden h-9 shrink-0 items-center gap-4 border-t border-line bg-surface px-3 font-mono text-xs tabular-nums text-muted md:flex">
                    {stats && (
                        <span className="shrink-0">
                            {stats.paths} paths · {stats.nodes} nodes ·{" "}
                            {stats.colors} colors · {formatBytes(svgBytes)}
                        </span>
                    )}
                    {busy && (
                        <span className="flex shrink-0 items-center gap-1.5 text-accent">
                            <Loader2 size={12} className="animate-spin" />
                            {progress || "Tracing…"}
                        </span>
                    )}
                    {error && (
                        <span className="truncate text-bad">{error}</span>
                    )}
                    <LegalLinksInline className="mx-auto shrink-0" />
                    <span className="hidden truncate sm:block">
                        {tool === "node"
                            ? "Drag anchors · double-click segment to add a node · Del removes"
                            : tool === "mark"
                              ? "Click to keep a region as its own shape · click a marker to remove · mark both sides of an overlap"
                              : "Scroll to zoom · drag to pan"}
                    </span>
                </footer>

                {/* ----------------------------------------- action bar (mobile) */}
                <StudioActionBar>
                    <Button
                        variant="secondary"
                        className="h-10"
                        icon={<SlidersHorizontal size={16} />}
                        onClick={() => setTraceSheetOpen(true)}
                    >
                        Trace
                    </Button>
                    {derivedDoc && (
                        <Button
                            variant="secondary"
                            className="h-10"
                            icon={<Layers size={16} />}
                            onClick={() => setPathsSheetOpen(true)}
                        >
                            {`Paths${stats ? ` (${stats.paths})` : ""}`}
                        </Button>
                    )}
                    <div className="flex-1" />
                    <Button
                        variant="primary"
                        className="h-10"
                        icon={applied ? <Check size={16} /> : undefined}
                        onClick={onApply}
                        disabled={!svgText}
                    >
                        {applied ? "Applied" : "Apply"}
                    </Button>
                </StudioActionBar>
            </div>

            {/* Desktop right rail — hidden below md; its body shows in the Paths sheet. */}
            {derivedDoc && (
                <PathsPanel
                    doc={derivedDoc}
                    selectedPathId={selectedPathId}
                    onSelectPath={handleSelectPath}
                    onRecolor={handleRecolor}
                    onToggleVisible={handleToggleVisible}
                    onDelete={handleDeleteItem}
                />
            )}

            {/* Mobile control sheets. */}
            <Sheet
                open={traceSheetOpen}
                onClose={() => setTraceSheetOpen(false)}
                title="Trace settings"
                side="bottom"
            >
                <TraceControlsBody {...traceProps} />
            </Sheet>
            {derivedDoc && (
                <Sheet
                    open={pathsSheetOpen}
                    onClose={() => setPathsSheetOpen(false)}
                    title="Paths"
                    side="bottom"
                >
                    <PathsPanelBody
                        doc={derivedDoc}
                        selectedPathId={selectedPathId}
                        onSelectPath={handleSelectPath}
                        onRecolor={handleRecolor}
                        onToggleVisible={handleToggleVisible}
                        onDelete={handleDeleteItem}
                    />
                </Sheet>
            )}

            {showHelp && <PipelineExplainer opts={opts} onClose={() => setShowHelp(false)} />}
        </div>
    );
}

/* ------------------------------------------------------------ subcomponents */

/** Region-marker glyph colour (emerald) + halo, matching EditorCanvas. */
const MARKER_FILL = "#10b981";
const FLAT_MARKER_FILL = "#f59e0b"; // amber — "flat colour" markers
const REMOVE_MARKER_FILL = "#f43f5e"; // rose — "remove & heal" markers
const MARKER_HALO = "#ffffff";
/** Screen-px radius for clicking an existing marker to remove it. */
const MARKER_HIT_PX = 11;

/**
 * The original image in the same centered-fit framing as the editor canvas,
 * so split view shows pixel-identical composition on both sides. With the Mark
 * tool active it ALSO accepts region markers (you place them where the overlap
 * is actually visible — on the source — not only on the traced result), mapping
 * the click to the same NORMALIZED [0,1] image coords the editor canvas uses, so
 * the two stay in lock-step. Pins counter-scale by the zoom so they stay a
 * constant screen size, like the editor's.
 */
function OriginalPane({
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

function Chip({ children }: { children: React.ReactNode }) {
    return (
        <span className="pointer-events-none absolute left-2 top-2 rounded border border-line bg-surface/80 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted backdrop-blur">
            {children}
        </span>
    );
}

function StagePlaceholder({ busy }: { busy: boolean }) {
    return (
        <div className="flex h-full items-center justify-center">
            {busy ? (
                <Loader2 size={22} className="animate-spin text-muted" />
            ) : (
                <span className="text-xs text-muted">No result yet</span>
            )}
        </div>
    );
}

function ToolButton({
    title,
    onClick,
    disabled,
    children,
}: {
    title: string;
    onClick: () => void;
    disabled?: boolean;
    children: React.ReactNode;
}) {
    return (
        <Tooltip label={title}>
            <button
                type="button"
                aria-label={title}
                onClick={onClick}
                disabled={disabled}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
            >
                {children}
            </button>
        </Tooltip>
    );
}
