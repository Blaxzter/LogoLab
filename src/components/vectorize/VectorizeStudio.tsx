// The vectorize studio: trace controls (left rail), a pan/zoom stage with
// split / traced / original / overlay / difference views and a status bar, and
// the per-path list (right rail). The traced doc lives in undo/redo history.
//
// Traces the app's working logo by default. Every store binding is also a prop,
// so the icon sheet reuses the same studio to edit one tile.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useCheckerClass, useLogo, useStore } from "../../state/store";
import { usePanZoom } from "../../hooks/usePanZoom";
import { useHistory } from "../../hooks/useHistory";
import { getImageData } from "../../lib/image";
import {
    monoTraceScale,
    rasterCapFor,
    type MonoUpscalePlan,
} from "../../lib/traceInput/traceCaps";
import { toImageData, upscaleImageData } from "../../lib/sheet/crop";
import { hexToRgb, normalizeHex, rgbToHex } from "../../lib/colorUtils";
import { downloadText } from "../../lib/export/download";
import { cleanSvg } from "../../lib/export/svgClean";
import { logError } from "../../lib/report/errorLog";
import { clearFailure, raiseFailure } from "../../lib/report/failureNotice";
import { provideReportContext } from "../../lib/report/reportContext";
import { docStats, isStrokeOnly, parseSvg, serializeDoc } from "../../lib/path/model";
import { deleteNodes, moveNodes } from "../../lib/path/geometry";
import { regionProvenance } from "../../lib/path/topology";
import { deleteRegionNodes, removeRegionAndHeal, removeRegionSection, translateRegionNodes } from "../../lib/path/topologyEdit";
import {
    DEFAULT_VECTORIZE_OPTIONS,
    suggestGradients,
    traceImage,
} from "../../lib/trace";
import { traceImageOffThread, canTraceOffThread } from "../../lib/trace/traceOffThread";
import {
    applyInkMode,
    cutFraction,
    decideInkMode,
    inkLumaRange,
    type InkColorMode,
    type InkModePlan,
} from "../../lib/traceInput/ink";
import { aiUpscale, aiUpscaleFactor } from "../../lib/traceInput/aiUpscale";
import {
    canScoreOffThread,
    scoreOffThread,
    type TraceScore,
} from "../../lib/render/scoreOffThread";
import type { VectorizeOptions } from "../../types";
import {
    loadStudioSeed,
    saveStudioDoc,
    saveStudioView,
    type StudioSeed,
} from "./studioSession";
import { probeShouldApply, restoredDecision } from "./probeLedger";
import type { DocItem, EditableDoc, NodeRef, PathItem, Vec } from "../../lib/path/types";
import { TraceControls, TraceControlsBody } from "./TraceControls";
import { PathsPanel, PathsPanelBody } from "./PathsPanel";
import { PipelineExplainer } from "./PipelineExplainer";
import { Sheet } from "../ui/Sheet";
import { useIsMobile } from "../../hooks/useIsMobile";
import type { Tool, ViewMode } from "./studio/types";
import { StudioToolbar } from "./studio/StudioToolbar";
import { StudioMobileActionBar, StudioMobileTopBar } from "./studio/StudioMobileBars";
import { StudioStage } from "./studio/StudioStage";
import { StudioStatusBar } from "./studio/StudioStatusBar";

const DEBOUNCE_MS = 400;

/**
 * Above this Rec.709 luma the probed ink is clearly not black, so a mono trace
 * (always #000) is repainted with the ink's colour by default.
 */
const INK_IS_BLACK_LUMA = 32;

/**
 * Long side of the raster the fidelity score and Difference heat are measured
 * on. Deliberately below the trace resolution (1024–4096): rasterizing costs
 * O(pixels) per path, and scoring at 1024px barely moves the mean ΔE.
 */
const SCORE_MAX_DIM = 1024;

/** Settle time before a score is started. Longer than the trace debounce because
 *  this also fires on every committed node edit, and a drag commits per frame. */
const SCORE_DEBOUNCE_MS = 500;

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

/** The fields of a `LogoAsset` the studio actually traces — a sheet tile supplies the same six. */
export interface VectorizeSource {
    src: string | null;
    isSvg: boolean;
    svgText: string | null;
    naturalWidth: number;
    naturalHeight: number;
    fileName: string | null;
}

export interface VectorizeStudioProps {
    /** What to trace. Defaults to the app's working logo. */
    source?: VectorizeSource;
    /** Transparency backdrop class. Defaults to the global checker preference. */
    checkerClass?: string;
    /** What the Apply button does. Defaults to replacing the app's working logo. */
    onApply?: (svgText: string, width: number, height: number) => void;
    applyLabel?: string;
    appliedLabel?: string;
    /**
     * False when this studio is on screen but not in charge (a second instance,
     * or a host that owns the keyboard) — the global shortcut handler stands down.
     */
    active?: boolean;
    /** Trace parameters to start from (defaults to the app-wide defaults). */
    initialOptions?: VectorizeOptions;
    onOptionsChange?: (opts: VectorizeOptions) => void;
    /**
     * A document already traced for this source (e.g. by the icon sheet's batch).
     * Seeds the editor and skips the re-trace on mount.
     */
    initialDoc?: EditableDoc | null;
    /** Fires whenever the traced/edited document changes, so a host can keep it. */
    onResult?: (result: { doc: EditableDoc; svgText: string; stats: { paths: number; nodes: number; colors: number } } | null) => void;
    /** Host chrome for the start of the toolbar (e.g. "back to all icons"). */
    leading?: ReactNode;
    /**
     * Persist this studio's settings and document across a reload. Only the
     * /vectorize tab sets it; the sheet persists its tiles itself, and two studios
     * writing the same slot would overwrite each other.
     */
    persist?: boolean;
}

export function VectorizeStudio({
    source,
    checkerClass: checkerClassProp,
    onApply: onApplyProp,
    applyLabel,
    appliedLabel,
    active = true,
    initialOptions,
    onOptionsChange,
    initialDoc,
    onResult,
    leading,
    persist = false,
}: VectorizeStudioProps = {}) {
    const storeLogo = useLogo();
    const storeChecker = useCheckerClass();
    const setProcessedSvg = useStore((s) => s.setProcessedSvg);
    const assetKey = useStore((s) => s.assetKey);

    // The stored session, read once into a ref: the state initializers need it on
    // the first render, and a claimed document must not be claimed twice under
    // StrictMode's double invocation.
    const sessionRef = useRef<StudioSeed | undefined>(undefined);
    if (sessionRef.current === undefined) {
        sessionRef.current = persist
            ? loadStudioSeed(assetKey)
            : { view: null, doc: null, dirty: false };
    }
    const session = sessionRef.current;
    // The image being traced: the app's working logo unless a host passed one.
    const logo = source ?? storeLogo;
    const checkerClass = checkerClassProp ?? storeChecker;
    const pz = usePanZoom({ maxScale: 32 });
    // No Worker, no score: running it on the main thread would block the UI.
    const canScore = canScoreOffThread();
    const isMobile = useIsMobile();

    const [opts, setOpts] = useState<VectorizeOptions>(
        initialOptions ?? session.view?.opts ?? DEFAULT_VECTORIZE_OPTIONS,
    );
    // Output coordinate precision (decimals). 3dp preserves sub-pixel geometry when
    // the SVG is scaled past its trace resolution. Not a user knob.
    const precision = 3;
    const [forceColorOn, setForceColorOn] = useState(session.view?.forceColorOn ?? false);
    const [forceColor, setForceColor] = useState(session.view?.forceColor ?? "#14161c");
    const [showHelp, setShowHelp] = useState(false);
    const [retraceVector, setRetraceVector] = useState<"clean" | "retrace">(
        session.view?.retraceVector ?? "clean",
    );
    const [viewMode, setViewMode] = useState<ViewMode>(session.view?.viewMode ?? "split");
    const [tool, setTool] = useState<Tool>("pan");
    // Below md the rails live in bottom sheets opened from the action bar.
    const [traceSheetOpen, setTraceSheetOpen] = useState(false);
    const [pathsSheetOpen, setPathsSheetOpen] = useState(false);
    const [overlayOpacity, setOverlayOpacity] = useState(session.view?.overlayOpacity ?? 60);
    // Markers have no enable switch: with none placed the trace is unchanged. The
    // only transient state is placement mode (tool === 'mark').

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
    // Settings changed since the last completed trace but not applied: set when a
    // trace is stopped mid-flight.
    const [staleOpts, setStaleOpts] = useState(false);

    const [busy, setBusy] = useState(false);
    const [progress, setProgress] = useState("");
    // Determinate progress in [0,1] from the tracer; 0 ⇒ indeterminate (show the sweep).
    const [progressFraction, setProgressFraction] = useState(0);
    // Pre-merge region map (fine regions before the gradient field-merge) from the
    // last trace — drives the region hover-highlight while placing markers.
    const [preMerge, setPreMerge] = useState<{ labels: Int32Array; width: number; height: number } | null>(null);
    // Fill currently hovered in the palette / paths list — the canvas lights up every
    // region painted exactly this colour so the user can locate (and then delete) it.
    const [highlightFill, setHighlightFill] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    // Distance from the source, measured off-thread. The status-bar mean ΔE and the
    // Difference heat come from one field so they can't disagree.
    const [score, setScore] = useState<TraceScore | null>(null);
    // The source decoded once at SCORE_MAX_DIM and kept: the score re-runs on every
    // edit, and re-decoding the image for each of them is the expensive half.
    const scoreSourceRef = useRef<{ src: string; img: ImageData } | null>(null);
    // The error object behind the status message, kept for bug reports: the worker
    // catches its own failures, so otherwise there would be nothing to attach.
    const [failure, setFailure] = useState<unknown>(null);
    // What Auto enlargement did on the last run, so the Upscale control can say
    // "×3 — its strokes are 1px" instead of leaving the user to guess.
    const [autoUpscale, setAutoUpscale] = useState<MonoUpscalePlan | null>(null);
    const [copied, setCopied] = useState(false);
    const [applied, setApplied] = useState(false);
    const runIdRef = useRef(0);
    const abortRef = useRef<AbortController | null>(null);
    // Pending debounced auto-run timer, shared so Stop can cancel it (otherwise a
    // re-trace armed just before Stop fires ~DEBOUNCE_MS later and clobbers the doc).
    const autoRunTimerRef = useRef<number | null>(null);
    // Auto-default for the gradients toggle from image content (flat ⇒ off, ramps
    // ⇒ on). `gradientsTouchedRef` pins a manual choice; `autoGradientsSrcRef`
    // ensures each image is probed once.
    const gradientsTouchedRef = useRef(session.view?.gradientsTouched ?? false);
    const autoGradientsSrcRef = useRef<string | null>(null);
    /**
     * The image (assetKey) the probes below last decided options for. On a restore
     * the probes only measure, so they don't reset the user's options. Keyed to the
     * image, not a mount flag: a "Clean SVG" source never probes, so a mount flag
     * would survive an upload and hand the new image the old image's options
     * (see probeLedger.ts).
     */
    const decidedForRef = useRef<string | null>(
        restoredDecision(session.view),
    );

    // Colour vs mono, the mono cut, and invert. `auto` asks the ink probe
    // (src/lib/traceInput/ink.ts), the same decision /sheet and the MCP server make. A host
    // that already planned the trace (the icon sheet) passes its own mode.
    const [colorMode, setColorMode] = useState<InkColorMode>(
        initialOptions ? initialOptions.mode : (session.view?.colorMode ?? "auto"),
    );
    // Read inside the probe effect so flipping Mode doesn't re-run (and re-decode) it.
    const colorModeRef = useRef<InkColorMode>(colorMode);
    // What the probe last saw — drives the "why" line under Mode, and the offer to
    // paint a mono trace in the ink's own colour instead of #000.
    const [inkPlan, setInkPlan] = useState<InkModePlan | null>(null);
    // The probed 512px raster, kept so a Mode flip re-decides without re-decoding.
    const probePixelsRef = useRef<ImageData | null>(null);
    // Pins the force-colour toggle once the user touches it, so the ink offer
    // never overrides a deliberate choice (same contract as gradientsTouchedRef).
    const forceColorTouchedRef = useRef(session.view?.forceColorTouched ?? false);

    /**
     * Resolve colour/mono for the current image and push it into the options.
     * Called on a fresh probe and whenever Mode changes: a forced Mono still wants
     * the measured cut and invert flag.
     *
     * `apply: false` only records the measurement (for the "why" line and the mono
     * guide) and leaves the options alone, as a restored session needs.
     */
    const applyInkDecision = useCallback(
        (mode: InkColorMode, pixels?: ImageData | null, apply = true) => {
            const img = pixels ?? probePixelsRef.current;
            if (!img) {
                // No probe result yet (or the decode failed). An explicit choice still
                // applies, without a measured cut; Auto waits for the probe.
                if (apply && mode !== "auto") {
                    setOpts((o) => (o.mode === mode ? o : { ...o, mode }));
                }
                return;
            }
            const plan = decideInkMode(img, DEFAULT_VECTORIZE_OPTIONS.threshold, {
                colorMode: mode,
            });
            setInkPlan(plan);
            if (!apply) return;
            setOpts((o) => {
                const next = applyInkMode(o, plan);
                // Avoid a spurious re-trace when nothing actually moved.
                return next.mode === o.mode &&
                    next.threshold === o.threshold &&
                    (next.invert ?? false) === (o.invert ?? false)
                    ? o
                    : next;
            });
            // A mono trace comes back #000. Seed the recolor with the ink's real colour,
            // and turn it on when the ink is clearly not black (e.g. white on navy).
            if (plan.recolor && !forceColorTouchedRef.current) {
                setForceColor(plan.recolor);
                setForceColorOn(
                    plan.probe.inkLuma != null && plan.probe.inkLuma > INK_IS_BLACK_LUMA,
                );
            }
        },
        [],
    );

    /**
     * What the current mono cut admits, so the panel can show an empty result
     * before it happens. Keyed on `inkPlan` because it is set from the same pixels
     * as `probePixelsRef`, which the memo can't observe directly.
     */
    const monoGuide = useMemo(() => {
        const img = probePixelsRef.current;
        if (!img || !inkPlan || opts.mode !== "mono") return null;
        const range = inkLumaRange(img);
        if (!range) return null;
        return {
            // Cuts that select nothing: with Invert off the ink is below the cut, so cuts
            // at or under the darkest pixel are dead; with it on, cuts at or over the
            // lightest. The all-solid end isn't marked: on art over transparency that is
            // the silhouette, a real result.
            deadOff: Math.floor(range.min),
            deadOn: Math.ceil(range.max),
            fracOff: cutFraction(img, opts.threshold, false),
            fracOn: cutFraction(img, opts.threshold, true),
        };
    }, [inkPlan, opts.mode, opts.threshold]);

    const isVectorSource = logo.isSvg && Boolean(logo.svgText);
    const cleanFromExisting = isVectorSource && retraceVector === "clean";

    /** Reset the mono cut to what the probe measured for this image. */
    const useMeasuredCut = useCallback(() => {
        if (!inkPlan) return;
        setOpts((o) => ({
            ...o,
            threshold: inkPlan.threshold,
            invert: inkPlan.invert,
        }));
    }, [inkPlan]);
    // Precision only re-runs the pipeline in clean mode (cleanSvg rounds the
    // markup); in trace mode it is applied at serialize time.
    const cleanPrecision = cleanFromExisting ? precision : -1;

    /* ----------------------------------------------------------- selection */

    // Mirror of selectedPathId so selection callbacks stay referentially stable.
    const selectedPathRef = useRef<string | null>(null);
    // Last in-region click that selected a path: the seed for a "remove & heal"
    // delete (which blob of a multi-blob colour to dissolve). Tied to an item id so
    // a stale seed from a previously-selected path is ignored.
    const seedRef = useRef<{ id: string; pt: Vec } | null>(null);

    const handleSelectPath = useCallback((id: string | null) => {
        if (selectedPathRef.current !== id) setSelectedNodes(new Set());
        selectedPathRef.current = id;
        setSelectedPathId(id);
    }, []);

    const handleSelectNodes = useCallback(
        (keys: Set<string>) => setSelectedNodes(keys),
        [],
    );

    const handleRegionSeed = useCallback((id: string, pt: Vec) => {
        seedRef.current = { id, pt };
    }, []);

    /* ------------------------------------------------------------ doc flow */

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

    /* ------------------------------------------------------- region markers */

    // Markers live in `opts.markers` so they flow into the trace and explainer,
    // survive a re-trace and pass through the worker. Coordinates are normalized
    // to [0,1].
    const markers = useMemo(() => opts.markers ?? [], [opts.markers]);

    // Which kind of marker a click drops: "separate" (keep the region distinct, its
    // paint untouched), "flat" (also pin it to its pre-merge flat form + solid), or
    // "remove" (dissolve the section and heal its neighbours into the gap).
    const [markMode, setMarkMode] = useState<"separate" | "flat" | "remove">(
        session.view?.markMode ?? "separate",
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

    // Latest opts / doc, read inside handlePaletteChange without re-creating it.
    const optsRef = useRef(opts);
    optsRef.current = opts;
    const docRef = useRef(doc);
    docRef.current = doc;

    // Published for the crash screen's bug report (lib/report/reportContext). Reads the
    // refs, not closed-over values, so the snapshot taken at crash time describes
    // the options live then. Never includes pixels, only the image's shape.
    useEffect(
        () =>
            provideReportContext(persist ? "vectorize" : "sheet-tile", () => ({
                source: {
                    width: logo.naturalWidth,
                    height: logo.naturalHeight,
                    isSvg: logo.isSvg,
                },
                colorMode,
                traced: docRef.current ? docStats(docRef.current) : null,
                options: optsRef.current,
            })),
        [persist, colorMode, logo.naturalWidth, logo.naturalHeight, logo.isSvg],
    );

    // Set just before an opacity-only palette edit so the auto-run effect skips the
    // (now-redundant) re-trace — the canvas was already recoloured live.
    const skipRetraceRef = useRef(false);

    // Lock / edit / clear the flat-art palette. An array locks it; null reverts to
    // automatic extraction. An opacity-only change can't move a region boundary, so
    // the matching paths' fill-opacity is updated live and the re-trace skipped;
    // hue / add / remove fall through to the debounced re-trace.
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

    // Markers only apply to colour tracing; leaving that mode exits the placement
    // tool (the markers persist).
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
        setFailure(null);
        // Drop the old score; the scoring effect starts a new one when this run lands.
        setScore(null);
        // A new attempt clears the previous failure prompt without recording it as
        // dismissed, since the user never answered it.
        clearFailure();
        setStaleOpts(false); // we're applying the current settings now
        setProgress(cleanFromExisting ? "Cleaning SVG…" : "Tracing…");
        setProgressFraction(0);
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
                // Gradient/photo colour art keeps the 1024 cap (the gradient merge is
                // costly); mono and flat colour trace at full resolution. The Detail preset
                // lifts the flat cap to 4096.
                let imageData = await getImageData(
                    logo.src,
                    rasterCapFor(opts),
                    logo.isSvg ? logo.svgText : null,
                );
                if (runId !== runIdRef.current) return;
                // Opt-in AI super-resolution for small rasters only (SVG sources are already
                // rasterized at full detail). The doc comes back in the enlarged pixel space;
                // markers are normalized and the overlay fits by aspect, so nothing downstream
                // cares. Size rule: src/lib/traceInput/aiUpscale.ts.
                setAutoUpscale(null);
                const upscaleBy = opts.upscale === "ai" && !logo.isSvg
                    ? aiUpscaleFactor(Math.max(imageData.width, imageData.height))
                    : 0;
                if (upscaleBy) {
                    setProgress(`Upscaling ×${upscaleBy}…`);
                    imageData = await aiUpscale(
                        imageData,
                        upscaleBy,
                        (p) => {
                            if (runId !== runIdRef.current) return;
                            setProgress(
                                p.phase === "download"
                                    ? `Downloading upscaler${p.percent != null ? ` — ${p.percent}%` : "…"}`
                                    : `Upscaling ×${p.factor}…`,
                            );
                        },
                        controller.signal,
                    );
                    if (runId !== runIdRef.current) return;
                    setProgress("Tracing…");
                } else if (!logo.isSvg) {
                    // Auto: a small or thin-stroked mono raster is enlarged bilinearly
                    // first (size and stroke rules in traceCaps.ts). Factor 1 for colour,
                    // Off, or when the raster is already near the cap. Also reached with
                    // `upscale: 'ai'` when the AI path declined the raster.
                    const plan = monoTraceScale(imageData, opts);
                    setAutoUpscale(plan);
                    if (plan.scale > 1) {
                        setProgress(`Enlarging ×${plan.scale}…`);
                        // Yield so the label paints before the synchronous resample.
                        await new Promise((r) => setTimeout(r));
                        if (runId !== runIdRef.current) return;
                        imageData = toImageData(upscaleImageData(imageData, plan.scale));
                        setProgress("Tracing…");
                    }
                }
                // The tracer runs in a Web Worker (pure JS) so the UI stays responsive;
                // `canTraceOffThread` only says no where there is no Worker at all.
                const runTrace = canTraceOffThread(opts) ? traceImageOffThread : traceImage;
                next = await runTrace(
                    imageData,
                    opts,
                    (p) => {
                        if (runId !== runIdRef.current) return;
                        setProgress(p.label);
                        setProgressFraction(p.fraction);
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
            logError("trace", err);
            if (runId === runIdRef.current) {
                const message =
                    "Could not vectorize this image — try different settings or another file.";
                setError(message);
                setFailure(err);
                // Also ask whether to report it; the status line alone is easy to miss.
                raiseFailure("the vectorizer", message, err);
            }
        } finally {
            if (runId === runIdRef.current) {
                setBusy(false);
                setProgress("");
                setProgressFraction(0);
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

    // Cancel an in-flight trace: clear any pending debounced auto-run (it would
    // otherwise replace the doc shortly after), bump the run id so late results are
    // ignored, abort the worker, and clear the busy UI. The previous document stays;
    // `staleOpts` marks the result as lagging the settings so the controls offer a
    // re-trace.
    const stop = useCallback(() => {
        if (autoRunTimerRef.current !== null) {
            window.clearTimeout(autoRunTimerRef.current);
            autoRunTimerRef.current = null;
        }
        runIdRef.current++;
        abortRef.current?.abort();
        abortRef.current = null;
        setBusy(false);
        setProgress("");
        setProgressFraction(0);
        setStaleOpts(true);
    }, []);

    // Auto-default the gradients toggle from image content: flat art ⇒ off, real
    // ramps ⇒ on. Only a suggestion: a manual flip is never overridden, and each
    // image is probed once.
    useEffect(() => {
        const src = logo.src;
        if (!src) return;
        // Cleaned vector sources don't run the tracer, so the toggle is moot.
        if (isVectorSource && retraceVector === "clean") return;
        if (autoGradientsSrcRef.current === src) return;
        // Fresh image: re-enable the auto-decision. A restored image keeps its flags.
        const restoring = !probeShouldApply(decidedForRef.current, assetKey);
        if (!restoring) gradientsTouchedRef.current = false;
        let cancelled = false;
        void (async () => {
            try {
                const img = await getImageData(
                    src,
                    512,
                    logo.isSvg ? logo.svgText : null,
                );
                // Claim after the decode, not before: under StrictMode the effect runs
                // twice, and claiming before the await would let the cancelled first run
                // mark the image done so the live run applies nothing.
                if (cancelled || gradientsTouchedRef.current) return;
                autoGradientsSrcRef.current = src; // probe once per image
                // The ink probe reuses the same decode; the pixels are kept so a manual
                // Mode change can re-decide without decoding again.
                probePixelsRef.current = img;
                // On a restore the probe only measures (see decidedForRef). Either way the
                // options now stand decided for this image, so a new upload probes afresh.
                decidedForRef.current = assetKey;
                applyInkDecision(colorModeRef.current, img, !restoring);
                if (restoring) return;
                const on = suggestGradients(img);
                setOpts((o) => {
                    // Skip if the user beat the probe, or it matches the effective
                    // state already (avoid a spurious re-trace).
                    if (gradientsTouchedRef.current) return o;
                    const currentlyOn = o.gradients !== false;
                    return currentlyOn === on ? o : { ...o, gradients: on };
                });
            } catch {
                // Best-effort: on decode failure leave the default in place.
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [
        logo.src,
        logo.isSvg,
        logo.svgText,
        assetKey,
        isVectorSource,
        retraceVector,
        applyInkDecision,
    ]);

    // Adopt a document the host already traced for this source (the icon sheet
    // traces tiles in a batch). Runs before the auto-run effect and claims the
    // gradient probe and first run, so opening an icon doesn't re-trace it.
    useEffect(() => {
        // Same for a restored document: it was traced from these pixels.
        const seeded = initialDoc ?? session.doc;
        if (!seeded) return;
        historyReset(seeded);
        skipRetraceRef.current = true;
        // A restored doc keeps its own dirty flag: hand-edited nodes must still
        // make a settings change warn instead of silently re-tracing over them.
        dirtyRef.current = initialDoc ? false : session.dirty;
        if (initialDoc) gradientsTouchedRef.current = true;
        autoGradientsSrcRef.current = initialDoc ? logo.src : null;
        // Mount only: a later prop change means the host swapped tiles, and that
        // remounts the studio (keyed by tile id) rather than mutating this one.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Auto-run (debounced) whenever the source or parameters change — unless
    // the user has hand-edited paths, in which case their edits win.
    useEffect(() => {
        // An opacity-only palette edit already recoloured the canvas live (geometry
        // is unchanged), so the trace would be wasted work — skip this one run.
        if (skipRetraceRef.current) {
            skipRetraceRef.current = false;
            return;
        }
        if (dirtyRef.current) {
            setStaleEdits(true);
            return;
        }
        const id = window.setTimeout(() => {
            autoRunTimerRef.current = null;
            void run();
        }, DEBOUNCE_MS);
        autoRunTimerRef.current = id;
        return () => {
            window.clearTimeout(id);
            autoRunTimerRef.current = null;
        };
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

    // Auto-extracted flat palette: the distinct solid fills of the base doc (not the
    // force-coloured one) in paint order, with alpha from fill-opacity. Gradient
    // items are skipped. Seeds the palette editor.
    const autoPalette = useMemo(() => {
        if (!doc) return [];
        const seen = new Set<string>();
        const out: { r: number; g: number; b: number; a?: number }[] = [];
        for (const it of doc.items) {
            if (it.kind !== "path" || it.gradient) continue;
            const hex = normalizeHex(it.fill);
            if (!hex) continue;
            const a =
                it.fillOpacity !== undefined && it.fillOpacity < 1
                    ? Math.round(it.fillOpacity * 255)
                    : 255;
            const key = `${hex}-${a}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const rgb = hexToRgb(hex);
            if (rgb) out.push(a < 255 ? { ...rgb, a } : rgb);
        }
        return out;
    }, [doc]);

    // The flat-palette editor (right rail) only applies to color tracing with
    // gradients off — the path the palette-first segmenter owns. Hidden otherwise.
    const flatPaletteActive =
        (!isVectorSource || retraceVector === "retrace") &&
        opts.mode === "color" &&
        opts.gradients === false;
    const lockedPalette =
        opts.palette && opts.palette.length > 0 ? opts.palette : null;

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

    /**
     * The trace came back empty: explain it on the canvas, where the user is
     * looking, with a one-click fix when there is one. The controls already flag
     * dead settings; this covers what slips through.
     */
    const emptyNotice = useMemo((): {
        text: string;
        action?: { label: string; run: () => void };
    } | null => {
        if (busy || !derivedDoc || !stats || stats.paths > 0) return null;

        // Nothing in the source to begin with; no setting recovers that.
        if (inkPlan?.inks === 0) {
            return {
                text: "This image looks empty — every pixel matches its background, so there is nothing to trace.",
            };
        }

        // A mono cut with all the ink on the wrong side of it. The probe knows
        // which side works, so the fix is one button rather than an instruction.
        if (opts.mode === "mono" && monoGuide) {
            const here = opts.invert ? monoGuide.fracOn : monoGuide.fracOff;
            const there = opts.invert ? monoGuide.fracOff : monoGuide.fracOn;
            if (here === 0 && there > 0) {
                return {
                    text: `This cut selects no pixels, so nothing was traced. Inverting it selects ${
                        there < 0.01 ? (there * 100).toFixed(1) : Math.round(there * 100)
                    }% of the visible pixels.`,
                    action: {
                        label: "Flip Invert",
                        run: () => setOpts((o) => ({ ...o, invert: !o.invert })),
                    },
                };
            }
            if (here === 0) {
                return {
                    text: "This threshold selects no pixels, so nothing was traced.",
                    action: inkPlan
                        ? { label: `Use the measured cut (${inkPlan.threshold})`, run: useMeasuredCut }
                        : undefined,
                };
            }
        }

        // Everything else: say so plainly rather than guess at a cause.
        return {
            text: "The trace came back empty — nothing in the image matched these settings.",
            action:
                colorMode !== "auto"
                    ? { label: "Let Auto decide", run: () => { setColorMode("auto"); colorModeRef.current = "auto"; applyInkDecision("auto"); } }
                    : undefined,
        };
    }, [
        busy,
        derivedDoc,
        stats,
        inkPlan,
        monoGuide,
        opts.mode,
        opts.invert,
        colorMode,
        useMeasuredCut,
        applyInkDecision,
    ]);

    // Reset the "Applied" badge whenever the output changes.
    useEffect(() => {
        setApplied(false);
    }, [svgText]);

    /**
     * Score the result against the source image.
     *
     * - The source is decoded like the tracer decodes it (`getImageData`, alpha
     *   intact) and composited over white inside the metric. Don't decode it onto a
     *   backdrop here, or art on transparency scores a correct trace as wrong.
     * - The scored document is `derivedDoc` (force colour included), the same doc
     *   the rest of the status bar describes.
     *
     * Skipped while a trace is running.
     */
    useEffect(() => {
        if (busy) return; // run() cleared it; scoring a doc about to be replaced is waste
        if (!derivedDoc || !logo.src || !canScore) {
            setScore(null);
            return;
        }
        const src = logo.src;
        const svgSource = logo.isSvg ? logo.svgText : null;
        let cancelled = false;
        const controller = new AbortController();
        const timer = window.setTimeout(() => {
            void (async () => {
                try {
                    let cached = scoreSourceRef.current;
                    if (cached?.src !== src) {
                        const img = await getImageData(src, SCORE_MAX_DIM, svgSource);
                        if (cancelled) return;
                        cached = { src, img };
                        scoreSourceRef.current = cached;
                    }
                    const img = cached.img;
                    const vbW = derivedDoc.viewBox[2];
                    if (!(vbW > 0)) return;
                    // The doc's viewBox is the trace raster (or a cleaned SVG's own units);
                    // `scale` renders it into the score raster's pixel space either way.
                    const next = await scoreOffThread(
                        derivedDoc,
                        img,
                        img.width / vbW,
                        controller.signal,
                    );
                    if (!cancelled) setScore(next);
                } catch (err) {
                    if (cancelled || (err instanceof DOMException && err.name === "AbortError"))
                        return;
                    // A failed score just means no readout; the trace itself is fine.
                    logError("fidelity", err);
                    setScore(null);
                }
            })();
        }, SCORE_DEBOUNCE_MS);
        return () => {
            cancelled = true;
            controller.abort();
            window.clearTimeout(timer);
        };
    }, [busy, canScore, derivedDoc, logo.src, logo.isSvg, logo.svgText]);

    // Report the current result / parameters to a host that is keeping them (the
    // icon sheet stores every tile's doc so it survives leaving the icon).
    useEffect(() => {
        if (!onResult) return;
        onResult(derivedDoc && svgText && stats ? { doc: derivedDoc, svgText, stats } : null);
    }, [onResult, derivedDoc, svgText, stats]);

    useEffect(() => {
        onOptionsChange?.(opts);
    }, [onOptionsChange, opts]);

    /* -------------------------------------------------------- session save */

    // Settings go to localStorage so they apply synchronously on the next mount.
    // The two "touched" flags are refs; they only change alongside a value in the
    // dependency list, so this effect sees them fresh.
    useEffect(() => {
        if (!persist) return;
        saveStudioView({
            opts,
            colorMode,
            forceColorOn,
            forceColor,
            forceColorTouched: forceColorTouchedRef.current,
            gradientsTouched: gradientsTouchedRef.current,
            probedAssetKey: decidedForRef.current,
            retraceVector,
            viewMode,
            overlayOpacity,
            markMode,
        });
    }, [
        persist,
        opts,
        colorMode,
        forceColorOn,
        forceColor,
        retraceVector,
        viewMode,
        overlayOpacity,
        markMode,
    ]);

    // The document goes to IndexedDB, keyed to its source image. Save the history
    // value, not `derivedDoc`: force colour is a view, and baking it in would lose
    // the real fills. Don't delete the slot on a null doc: it is null for one
    // commit on mount before the seed lands.
    useEffect(() => {
        if (!persist || !doc) return;
        saveStudioDoc(assetKey, doc, dirtyRef.current);
    }, [persist, assetKey, doc]);

    // The Paths sheet is gated on `derivedDoc`; if the doc ever clears, drop the
    // open flag so the sheet can't silently re-open when a doc returns.
    useEffect(() => {
        if (!derivedDoc) setPathsSheetOpen(false);
    }, [derivedDoc]);

    /* ------------------------------------------------------------ keyboard */

    // Window-level, so a studio that is mounted but not in charge must stand down,
    // or two studios would both undo on one Ctrl+Z.
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

    /* ---------------------------------------------------------- panel edits */

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
        // Default: become the app's working logo. The icon sheet passes its own sink,
        // since replacing the logo would destroy the sheet.
        (onApplyProp ?? setProcessedSvg)(svgText, w, h);
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
            setFailure(null);
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
        highlightFill,
        onSelectPath: handleSelectPath,
        onSelectNodes: handleSelectNodes,
        onRegionSeed: handleRegionSeed,
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
        sourceMaxDim:
            Math.max(logo.naturalWidth ?? 0, logo.naturalHeight ?? 0) || undefined,
        autoUpscale,
        onPatch: (p: Partial<VectorizeOptions>) => {
            // A hand-flip of the gradients toggle pins it: the content probe must
            // not override a deliberate user choice for this image.
            if ("gradients" in p) gradientsTouchedRef.current = true;
            setOpts((o) => ({ ...o, ...p }));
        },
        colorMode,
        onColorMode: (m: InkColorMode) => {
            setColorMode(m);
            colorModeRef.current = m;
            // Re-decide from the pixels we already have: a forced Mono still wants
            // the measured cut and the invert flag, not the 128 default.
            applyInkDecision(m);
        },
        inkPlan,
        monoGuide,
        forceColorOn,
        onForceColorOn: (on: boolean) => {
            forceColorTouchedRef.current = true;
            setForceColorOn(on);
        },
        forceColor,
        onForceColor: (c: string) => {
            forceColorTouchedRef.current = true;
            setForceColor(c);
        },
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
        staleOpts,
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
        <div className="canvas-ui flex h-full min-h-0 shrink-0 animate-in-fade">
            <TraceControls {...traceProps} />

            <div className="flex min-w-0 flex-1 flex-col">
                <StudioToolbar
                    leading={leading}
                    viewMode={viewMode}
                    setViewMode={setViewMode}
                    tool={tool}
                    setTool={setTool}
                    opts={opts}
                    isVectorSource={isVectorSource}
                    retraceVector={retraceVector}
                    markers={markers}
                    undo={undo}
                    redo={redo}
                    canUndo={canUndo}
                    canRedo={canRedo}
                    overlayOpacity={overlayOpacity}
                    setOverlayOpacity={setOverlayOpacity}
                    pz={pz}
                    applied={applied}
                    applyLabel={applyLabel}
                    appliedLabel={appliedLabel}
                    onApply={onApply}
                    onDownload={onDownload}
                    copied={copied}
                    onCopy={onCopy}
                    svgText={svgText}
                />

                <StudioMobileTopBar
                    leading={leading}
                    view={view}
                    setViewMode={setViewMode}
                    tool={tool}
                    setTool={setTool}
                    undo={undo}
                    redo={redo}
                    canUndo={canUndo}
                    canRedo={canRedo}
                    overlayOpacity={overlayOpacity}
                    setOverlayOpacity={setOverlayOpacity}
                    pz={pz}
                    copied={copied}
                    onCopy={onCopy}
                    onDownload={onDownload}
                    svgText={svgText}
                />

                <StudioStage
                    view={view}
                    checkerClass={checkerClass}
                    tool={tool}
                    setTool={setTool}
                    markMode={markMode}
                    pz={pz}
                    logo={{ src: logo.src, naturalWidth: logo.naturalWidth, naturalHeight: logo.naturalHeight }}
                    markers={markers}
                    addMarker={addMarker}
                    removeMarker={removeMarker}
                    canvasShared={canvasShared}
                    derivedDoc={derivedDoc}
                    busy={busy}
                    progress={progress}
                    progressFraction={progressFraction}
                    stop={stop}
                    overlayOpacity={overlayOpacity}
                    score={score}
                    canScore={canScore}
                    emptyNotice={emptyNotice}
                />

                <StudioStatusBar
                    stats={stats}
                    svgBytes={svgBytes}
                    score={score}
                    setViewMode={setViewMode}
                    busy={busy}
                    progress={progress}
                    stop={stop}
                    error={error}
                    failure={failure}
                    tool={tool}
                />

                <StudioMobileActionBar
                    setTraceSheetOpen={setTraceSheetOpen}
                    setPathsSheetOpen={setPathsSheetOpen}
                    derivedDoc={derivedDoc}
                    stats={stats}
                    applied={applied}
                    applyLabel={applyLabel}
                    appliedLabel={appliedLabel}
                    onApply={onApply}
                    svgText={svgText}
                />
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
                    showPalette={flatPaletteActive}
                    autoPalette={autoPalette}
                    lockedPalette={lockedPalette}
                    onPaletteChange={handlePaletteChange}
                    onHighlight={setHighlightFill}
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
                        showPalette={flatPaletteActive}
                        autoPalette={autoPalette}
                        lockedPalette={lockedPalette}
                        onPaletteChange={handlePaletteChange}
                        onHighlight={setHighlightFill}
                    />
                </Sheet>
            )}

            {showHelp && (
                <PipelineExplainer
                    opts={opts}
                    source={logo}
                    onClose={() => setShowHelp(false)}
                />
            )}
        </div>
    );
}
