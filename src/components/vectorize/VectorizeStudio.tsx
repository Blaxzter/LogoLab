// The vectorize studio: trace controls (left rail), a pan/zoom stage with
// split / traced / original / overlay / difference views and a status bar, and
// the per-path list (right rail). The traced doc lives in undo/redo history.
//
// Traces the app's working logo by default. Every store binding is also a prop,
// so the icon sheet reuses the same studio to edit one tile.
//
// The state and effects live in hooks under ./studio, called in the order the
// effects must run; the chrome is split into the presentational parts there.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useCheckerClass, useLogo, useStore } from '../../state/store'
import { usePanZoom } from '../../hooks/usePanZoom'
import { useHistory } from '../../hooks/useHistory'
import { DEFAULT_VECTORIZE_OPTIONS } from '../../lib/trace'
import type { InkColorMode } from '../../lib/traceInput/ink'
import { canScoreOffThread, type TraceScore } from '../../lib/render/scoreOffThread'
import type { VectorizeOptions } from '../../types'
import { restoredDecision } from './probeLedger'
import type { EditableDoc } from '../../lib/path/types'
import { TraceControls, TraceControlsBody } from './TraceControls'
import { PathsPanel, PathsPanelBody } from './PathsPanel'
import { PipelineExplainer } from './PipelineExplainer'
import { Sheet } from '../ui/Sheet'
import { useIsMobile } from '../../hooks/useIsMobile'
import type { Tool, VectorizeSource, ViewMode } from './studio/types'
import { useSessionSave, useStudioSession } from './studio/useStudioSession'
import { useSelection } from './studio/useSelection'
import { useInkDecision } from './studio/useInkDecision'
import { useDocEdits } from './studio/useDocEdits'
import { useStudioReportContext } from './studio/useStudioReportContext'
import { useMarkers } from './studio/useMarkers'
import { useContentProbe } from './studio/useContentProbe'
import { useTraceRun } from './studio/useTraceRun'
import { useTraceOutput } from './studio/useTraceOutput'
import { useEmptyNotice } from './studio/useEmptyNotice'
import { useExportActions } from './studio/useExportActions'
import { useFidelityScore } from './studio/useFidelityScore'
import { useStudioShortcuts } from './studio/useStudioShortcuts'
import { StudioToolbar } from './studio/StudioToolbar'
import { StudioMobileActionBar, StudioMobileTopBar } from './studio/StudioMobileBars'
import { StudioStage } from './studio/StudioStage'
import { StudioStatusBar } from './studio/StudioStatusBar'

export type { VectorizeSource }

export interface VectorizeStudioProps {
  /** What to trace. Defaults to the app's working logo. */
  source?: VectorizeSource
  /** Transparency backdrop class. Defaults to the global checker preference. */
  checkerClass?: string
  /** What the Apply button does. Defaults to replacing the app's working logo. */
  onApply?: (svgText: string, width: number, height: number) => void
  applyLabel?: string
  appliedLabel?: string
  /**
   * False when this studio is on screen but not in charge (a second instance,
   * or a host that owns the keyboard) — the global shortcut handler stands down.
   */
  active?: boolean
  /** Trace parameters to start from (defaults to the app-wide defaults). */
  initialOptions?: VectorizeOptions
  onOptionsChange?: (opts: VectorizeOptions) => void
  /**
   * A document already traced for this source (e.g. by the icon sheet's batch).
   * Seeds the editor and skips the re-trace on mount.
   */
  initialDoc?: EditableDoc | null
  /** Fires whenever the traced/edited document changes, so a host can keep it. */
  onResult?: (
    result: { doc: EditableDoc; svgText: string; stats: { paths: number; nodes: number; colors: number } } | null,
  ) => void
  /** Host chrome for the start of the toolbar (e.g. "back to all icons"). */
  leading?: ReactNode
  /**
   * Persist this studio's settings and document across a reload. Only the
   * /vectorize tab sets it; the sheet persists its tiles itself, and two studios
   * writing the same slot would overwrite each other.
   */
  persist?: boolean
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
  const storeLogo = useLogo()
  const storeChecker = useCheckerClass()
  const setProcessedSvg = useStore((s) => s.setProcessedSvg)
  const assetKey = useStore((s) => s.assetKey)

  const session = useStudioSession(persist, assetKey)
  // The image being traced: the app's working logo unless a host passed one.
  const logo = source ?? storeLogo
  const checkerClass = checkerClassProp ?? storeChecker
  const pz = usePanZoom({ maxScale: 32 })
  // No Worker, no score: running it on the main thread would block the UI.
  const canScore = canScoreOffThread()
  const isMobile = useIsMobile()

  const [opts, setOpts] = useState<VectorizeOptions>(initialOptions ?? session.view?.opts ?? DEFAULT_VECTORIZE_OPTIONS)
  // Output coordinate precision (decimals). 3dp preserves sub-pixel geometry when
  // the SVG is scaled past its trace resolution. Not a user knob.
  const precision = 3
  const [forceColorOn, setForceColorOn] = useState(session.view?.forceColorOn ?? false)
  const [forceColor, setForceColor] = useState(session.view?.forceColor ?? '#14161c')
  const [showHelp, setShowHelp] = useState(false)
  const [retraceVector, setRetraceVector] = useState<'clean' | 'retrace'>(session.view?.retraceVector ?? 'clean')
  const [viewMode, setViewMode] = useState<ViewMode>(session.view?.viewMode ?? 'split')
  const [tool, setTool] = useState<Tool>('pan')
  // Below md the rails live in bottom sheets opened from the action bar.
  const [traceSheetOpen, setTraceSheetOpen] = useState(false)
  const [pathsSheetOpen, setPathsSheetOpen] = useState(false)
  const [overlayOpacity, setOverlayOpacity] = useState(session.view?.overlayOpacity ?? 60)
  // Markers have no enable switch: with none placed the trace is unchanged. The
  // only transient state is placement mode (tool === 'mark').

  const history = useHistory<EditableDoc>()
  const doc = history.value
  const { set: historySet, reset: historyReset, undo, redo, canUndo, canRedo } = history

  const {
    selectedPathId,
    selectedNodes,
    setSelectedNodes,
    selectedPathRef,
    seedRef,
    handleSelectPath,
    handleSelectNodes,
    handleRegionSeed,
  } = useSelection()
  // Manual edits win over the auto-run: while dirty, parameter changes only
  // arm the "re-trace discards edits" notice instead of re-tracing.
  const dirtyRef = useRef(false)

  // Fill currently hovered in the palette / paths list — the canvas lights up every
  // region painted exactly this colour so the user can locate (and then delete) it.
  const [highlightFill, setHighlightFill] = useState<string | null>(null)
  // Distance from the source, measured off-thread. The status-bar mean ΔE and the
  // Difference heat come from one field so they can't disagree.
  const [score, setScore] = useState<TraceScore | null>(null)
  // Auto-default for the gradients toggle from image content (flat ⇒ off, ramps
  // ⇒ on). `gradientsTouchedRef` pins a manual choice; `autoGradientsSrcRef`
  // ensures each image is probed once.
  const gradientsTouchedRef = useRef(session.view?.gradientsTouched ?? false)
  const autoGradientsSrcRef = useRef<string | null>(null)
  /**
   * The image (assetKey) the probes below last decided options for. On a restore
   * the probes only measure, so they don't reset the user's options. Keyed to the
   * image, not a mount flag: a "Clean SVG" source never probes, so a mount flag
   * would survive an upload and hand the new image the old image's options
   * (see probeLedger.ts).
   */
  const decidedForRef = useRef<string | null>(restoredDecision(session.view))

  const {
    colorMode,
    setColorMode,
    colorModeRef,
    inkPlan,
    probePixelsRef,
    forceColorTouchedRef,
    applyInkDecision,
    monoGuide,
    useMeasuredCut,
  } = useInkDecision({ session, initialOptions, opts, setOpts, setForceColor, setForceColorOn })

  const isVectorSource = logo.isSvg && Boolean(logo.svgText)
  const cleanFromExisting = isVectorSource && retraceVector === 'clean'
  // Precision only re-runs the pipeline in clean mode (cleanSvg rounds the
  // markup); in trace mode it is applied at serialize time.
  const cleanPrecision = cleanFromExisting ? precision : -1

  // Latest opts / doc, read inside handlePaletteChange without re-creating it.
  const optsRef = useRef(opts)
  optsRef.current = opts
  const docRef = useRef(doc)
  docRef.current = doc

  // Set just before an opacity-only palette edit so the auto-run effect skips the
  // (now-redundant) re-trace — the canvas was already recoloured live.
  const skipRetraceRef = useRef(false)

  const {
    commitDoc,
    handlePaletteChange,
    handleCanvasChange,
    handleCanvasCommit,
    handleRecolor,
    handleToggleVisible,
    handleDeleteItem,
  } = useDocEdits({
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
  })

  /* ------------------------------------------------------------ effects */
  // Effects run in call order: report context, marker tool, probe, seed,
  // auto-run, then the output-side effects below.

  useStudioReportContext({ persist, logo, colorMode, optsRef, docRef })

  const { markers, markMode, setMarkMode, addMarker, removeMarker, clearMarkers } = useMarkers({
    session,
    opts,
    setOpts,
    tool,
    setTool,
    isVectorSource,
    retraceVector,
  })

  useContentProbe({
    logo,
    assetKey,
    isVectorSource,
    retraceVector,
    applyInkDecision,
    setOpts,
    gradientsTouchedRef,
    autoGradientsSrcRef,
    decidedForRef,
    probePixelsRef,
    colorModeRef,
  })

  // Adopt a document the host already traced for this source (the icon sheet
  // traces tiles in a batch). Runs before the auto-run effect and claims the
  // gradient probe and first run, so opening an icon doesn't re-trace it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only: another tile remounts the studio (keyed by tile id)
  useEffect(() => {
    // Same for a restored document: it was traced from these pixels.
    const seeded = initialDoc ?? session.doc
    if (!seeded) return
    historyReset(seeded)
    skipRetraceRef.current = true
    // A restored doc keeps its own dirty flag: hand-edited nodes must still
    // make a settings change warn instead of silently re-tracing over them.
    dirtyRef.current = initialDoc ? false : session.dirty
    if (initialDoc) gradientsTouchedRef.current = true
    autoGradientsSrcRef.current = initialDoc ? logo.src : null
    // Mount only: a later prop change means the host swapped tiles, and that
    // remounts the studio (keyed by tile id) rather than mutating this one.
  }, [])

  const {
    staleEdits,
    staleOpts,
    busy,
    progress,
    progressFraction,
    preMerge,
    error,
    setError,
    failure,
    setFailure,
    autoUpscale,
    run,
    stop,
  } = useTraceRun({
    logo,
    opts,
    precision,
    cleanFromExisting,
    cleanPrecision,
    historyReset,
    handleSelectPath,
    setSelectedNodes,
    dirtyRef,
    skipRetraceRef,
    setScore,
  })

  /* ------------------------------------------------------------- derived */

  const { derivedDoc, autoPalette, svgText, svgBytes, stats } = useTraceOutput({
    doc,
    forceColorOn,
    forceColor,
    precision,
  })

  // The flat-palette editor (right rail) only applies to color tracing with
  // gradients off — the path the palette-first segmenter owns. Hidden otherwise.
  const flatPaletteActive =
    (!isVectorSource || retraceVector === 'retrace') && opts.mode === 'color' && opts.gradients === false
  const lockedPalette = opts.palette && opts.palette.length > 0 ? opts.palette : null

  const emptyNotice = useEmptyNotice({
    busy,
    derivedDoc,
    stats,
    inkPlan,
    monoGuide,
    opts,
    setOpts,
    colorMode,
    setColorMode,
    colorModeRef,
    useMeasuredCut,
    applyInkDecision,
  })

  const { copied, applied, onDownload, onApply, onCopy } = useExportActions({
    svgText,
    derivedDoc,
    fileName: logo.fileName,
    // Default: become the app's working logo. The icon sheet passes its own sink,
    // since replacing the logo would destroy the sheet.
    apply: onApplyProp ?? setProcessedSvg,
    setError,
    setFailure,
  })

  useFidelityScore({ busy, canScore, derivedDoc, logo, setScore })

  // Report the current result / parameters to a host that is keeping them (the
  // icon sheet stores every tile's doc so it survives leaving the icon).
  useEffect(() => {
    if (!onResult) return
    onResult(derivedDoc && svgText && stats ? { doc: derivedDoc, svgText, stats } : null)
  }, [onResult, derivedDoc, svgText, stats])

  useEffect(() => {
    onOptionsChange?.(opts)
  }, [onOptionsChange, opts])

  useSessionSave({
    persist,
    assetKey,
    doc,
    dirtyRef,
    opts,
    colorMode,
    forceColorOn,
    forceColor,
    forceColorTouchedRef,
    gradientsTouchedRef,
    decidedForRef,
    retraceVector,
    viewMode,
    overlayOpacity,
    markMode,
  })

  // The Paths sheet is gated on `derivedDoc`; if the doc ever clears, drop the
  // open flag so the sheet can't silently re-open when a doc returns.
  useEffect(() => {
    if (!derivedDoc) setPathsSheetOpen(false)
  }, [derivedDoc])

  useStudioShortcuts({
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
  })

  /* -------------------------------------------------------------- render */

  if (!logo.src) return null

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
  }

  // Below md the desktop-only split pane is too narrow — default to the single
  // traced pane (the mobile view-mode strip omits "split").
  const view: ViewMode = isMobile && viewMode === 'split' ? 'traced' : viewMode

  // One prop bag feeds both the desktop rail and the mobile Trace sheet.
  const traceProps = {
    isVectorSource,
    source: retraceVector,
    onSourceChange: setRetraceVector,
    opts,
    sourceMaxDim: Math.max(logo.naturalWidth ?? 0, logo.naturalHeight ?? 0) || undefined,
    autoUpscale,
    onPatch: (p: Partial<VectorizeOptions>) => {
      // A hand-flip of the gradients toggle pins it: the content probe must
      // not override a deliberate user choice for this image.
      if ('gradients' in p) gradientsTouchedRef.current = true
      setOpts((o) => ({ ...o, ...p }))
    },
    colorMode,
    onColorMode: (m: InkColorMode) => {
      setColorMode(m)
      colorModeRef.current = m
      // Re-decide from the pixels we already have: a forced Mono still wants
      // the measured cut and the invert flag, not the 128 default.
      applyInkDecision(m)
    },
    inkPlan,
    monoGuide,
    forceColorOn,
    onForceColorOn: (on: boolean) => {
      forceColorTouchedRef.current = true
      setForceColorOn(on)
    },
    forceColor,
    onForceColor: (c: string) => {
      forceColorTouchedRef.current = true
      setForceColor(c)
    },
    marking: tool === 'mark',
    onMarkingChange: (on: boolean) => setTool(on ? 'mark' : 'pan'),
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
      setTraceSheetOpen(false)
      void run()
    },
    onShowHelp: () => {
      setTraceSheetOpen(false)
      setShowHelp(true)
    },
  }

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
      <Sheet open={traceSheetOpen} onClose={() => setTraceSheetOpen(false)} title="Trace settings" side="bottom">
        <TraceControlsBody {...traceProps} />
      </Sheet>
      {derivedDoc && (
        <Sheet open={pathsSheetOpen} onClose={() => setPathsSheetOpen(false)} title="Paths" side="bottom">
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

      {showHelp && <PipelineExplainer opts={opts} source={logo} onClose={() => setShowHelp(false)} />}
    </div>
  )
}
