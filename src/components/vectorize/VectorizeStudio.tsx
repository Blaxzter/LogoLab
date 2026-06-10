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
    Loader2,
    MousePointer2,
    Redo2,
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
import { DEFAULT_VECTORIZE_OPTIONS, traceImage } from "../../lib/trace";
import type { VectorizeOptions } from "../../types";
import type { DocItem, EditableDoc, NodeRef } from "../../lib/path/types";
import { TraceControls } from "./TraceControls";
import { EditorCanvas, useFitBox } from "./EditorCanvas";
import { PathsPanel } from "./PathsPanel";

const RASTER_MAX_DIM = 1024;
const DEBOUNCE_MS = 400;

type ViewMode = "split" | "traced" | "original" | "overlay";
type Tool = "pan" | "node";

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

    const [opts, setOpts] = useState<VectorizeOptions>(
        DEFAULT_VECTORIZE_OPTIONS,
    );
    const [precision, setPrecision] = useState(2);
    const [forceColorOn, setForceColorOn] = useState(false);
    const [forceColor, setForceColor] = useState("#14161c");
    const [retraceVector, setRetraceVector] = useState<"clean" | "retrace">(
        "clean",
    );
    const [viewMode, setViewMode] = useState<ViewMode>("split");
    const [tool, setTool] = useState<Tool>("pan");
    const [overlayOpacity, setOverlayOpacity] = useState(60);

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
    // ever changes geometry/structure — restore the base fills before storing,
    // so toggling force color off never reveals baked-in overrides.
    const mergeFills = useCallback(
        (edited: EditableDoc): EditableDoc => {
            if (!forceColorOn || !doc) return edited;
            const fills = new Map<string, string>();
            for (const it of doc.items)
                if (it.kind === "path") fills.set(it.id, it.fill);
            return {
                ...edited,
                items: edited.items.map((it) =>
                    it.kind === "path" && fills.has(it.id)
                        ? { ...it, fill: fills.get(it.id)! }
                        : it,
                ),
            };
        },
        [doc, forceColorOn],
    );

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
                next = await traceImage(
                    imageData,
                    opts,
                    (p) => {
                        if (runId !== runIdRef.current) return;
                        setProgress(
                            p.phase === "quantize"
                                ? "Quantizing colors…"
                                : `Tracing layer ${p.layer}/${p.total}…`,
                        );
                    },
                    controller.signal,
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
                it.kind === "path" ? { ...it, fill: forceColor } : it,
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
                    const next = deleteNodes(
                        item,
                        [...selectedNodes].map(parseNodeKey),
                    );
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
                commitDoc(
                    withItem(
                        doc,
                        moveNodes(
                            item,
                            [...selectedNodes].map(parseNodeKey),
                            dx,
                            dy,
                        ),
                    ),
                );
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
    ]);

    /* ---------------------------------------------------------- panel edits */

    const handleRecolor = useCallback(
        (id: string, fill: string, commit: boolean) => {
            if (!doc) return;
            const next = {
                ...doc,
                items: doc.items.map((it) =>
                    it.id === id && it.kind === "path" ? { ...it, fill } : it,
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
        onSelectPath: handleSelectPath,
        onSelectNodes: handleSelectNodes,
        onDocChange: handleCanvasChange,
        onDocCommit: handleCanvasCommit,
    };

    return (
        <div className="flex h-full min-h-0 animate-in-fade">
            <TraceControls
                isVectorSource={isVectorSource}
                source={retraceVector}
                onSourceChange={setRetraceVector}
                opts={opts}
                onPatch={(p) => setOpts((o) => ({ ...o, ...p }))}
                precision={precision}
                onPrecision={setPrecision}
                forceColorOn={forceColorOn}
                onForceColorOn={setForceColorOn}
                forceColor={forceColor}
                onForceColor={setForceColor}
                busy={busy}
                staleEdits={staleEdits}
                onTrace={() => void run()}
            />

            <div className="flex min-w-0 flex-1 flex-col">
                {/* ------------------------------------------------------ toolbar */}
                <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-surface px-3">
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

                {/* -------------------------------------------------------- stage */}
                <div className={`relative min-h-0 flex-1 ${checkerClass}`}>
                    {viewMode === "split" && (
                        <div className="grid h-full grid-cols-2">
                            <div className="relative h-full min-w-0 border-r border-line">
                                <OriginalPane
                                    pz={pz}
                                    src={logo.src}
                                    aspectW={logo.naturalWidth || 1}
                                    aspectH={logo.naturalHeight || 1}
                                    primary
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
                    {viewMode === "traced" &&
                        (derivedDoc ? (
                            <EditorCanvas
                                {...canvasShared}
                                doc={derivedDoc}
                                primary
                            />
                        ) : (
                            <StagePlaceholder busy={busy} />
                        ))}
                    {viewMode === "original" && (
                        <OriginalPane
                            pz={pz}
                            src={logo.src}
                            aspectW={logo.naturalWidth || 1}
                            aspectH={logo.naturalHeight || 1}
                            primary
                        />
                    )}
                    {viewMode === "overlay" &&
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
                </div>

                {/* --------------------------------------------------- status bar */}
                <footer className="flex h-9 shrink-0 items-center gap-4 border-t border-line bg-surface px-3 font-mono text-xs tabular-nums text-muted">
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
                    <span className="ml-auto hidden truncate sm:block">
                        {tool === "node"
                            ? "Drag anchors · double-click segment to add a node · Del removes"
                            : "Scroll to zoom · drag to pan"}
                    </span>
                </footer>
            </div>

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
        </div>
    );
}

/* ------------------------------------------------------------ subcomponents */

/**
 * The original image in the same centered-fit framing as the editor canvas,
 * so split view shows pixel-identical composition on both sides.
 */
function OriginalPane({
    pz,
    src,
    aspectW,
    aspectH,
    primary = false,
}: {
    pz: PanZoom;
    src: string;
    aspectW: number;
    aspectH: number;
    primary?: boolean;
}) {
    const fit = useFitBox(aspectW, aspectH);
    return (
        <ZoomSurface pz={pz} primary={primary} className="h-full w-full">
            <div
                ref={fit.parentRef}
                className="flex h-full w-full items-center justify-center p-[6%]"
            >
                <div
                    className="relative"
                    style={{ width: fit.width, height: fit.height }}
                >
                    <img
                        src={src}
                        alt=""
                        draggable={false}
                        className="pointer-events-none h-full w-full select-none"
                    />
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
        <button
            type="button"
            title={title}
            onClick={onClick}
            disabled={disabled}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
        >
            {children}
        </button>
    );
}
