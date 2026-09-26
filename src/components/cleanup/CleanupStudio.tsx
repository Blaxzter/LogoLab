// The cleanup studio: useCleanupCanvas wired to a Vectorize-style shell. Left
// rail = removal tools, center = toolbar + pan/zoom stage (split / result /
// original / overlay) + status bar.
//
// Don't unmount the painting <canvas> when switching views: an unmounted canvas
// reports a 0-width rect and breaks the imgCoords painting math on return, so
// non-result views hide it with classes instead.
//
// Keep/remove markers are studio state; the hook reports placements via
// onMarkerPlaced, and the pins are cleared whenever the working buffer changes
// (source swap, Reset, Apply, AI, or a resize).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useCheckerClass, useLogo, useStore } from '../../state/store'
import { usePanZoom } from '../../hooks/usePanZoom'
import { useIsMobile } from '../../hooks/useIsMobile'
import { useCleanupCanvas, type CleanupTool, type KeepRemoveMarker } from '../../hooks/useCleanupCanvas'
import { Sheet } from '../ui/Sheet'
import { CleanupControls, CleanupControlsBody } from './CleanupControls'
import { CleanupStage, PaintingCanvas } from './CleanupStage'
import { CleanupToolbar, CleanupTopStrip, type ViewMode } from './CleanupToolbar'
import { CleanupActionBar, CleanupStatusBar } from './CleanupFooter'
import {
  cleanupSeed,
  loadCleanupSettings,
  saveCleanupPixels,
  saveCleanupSettings,
} from './cleanupSession'

export function CleanupStudio() {
  const logo = useLogo()
  const checkerClass = useCheckerClass()
  const pz = usePanZoom({ maxScale: 16 })
  const isMobile = useIsMobile()
  const assetKey = useStore((s) => s.assetKey)

  // ----------------------------------------------------------- studio state
  // Seeded from the last session (see cleanupSession.ts). Read once, in the
  // state initializers, so the rail is already the user's on the first frame.
  const stored = useRef(loadCleanupSettings()).current
  const [viewMode, setViewMode] = useState<ViewMode>(stored.viewMode)
  // Below md the controls live in a bottom sheet opened from the action bar.
  const [toolsOpen, setToolsOpen] = useState(false)
  const [tool, setTool] = useState<CleanupTool>(stored.tool)
  const [tolerance, setTolerance] = useState(stored.tolerance)
  const [softness, setSoftness] = useState(stored.softness)
  const [brushSize, setBrushSize] = useState(stored.brushSize)
  // How hard each Magic / By color / Auto removal cleans the colored fringe off
  // soft edges (0 = off). See defringe() in bgRemove.ts.
  const [defringeStrength, setDefringeStrength] = useState(stored.defringeStrength)
  const [ghostOpacity, setGhostOpacity] = useState(stored.ghostOpacity)
  const [matteOn, setMatteOn] = useState(stored.matteOn)
  const [matteColor, setMatteColor] = useState(stored.matteColor)
  // Edge-refine / trim slider values (the op runs on its own Apply button).
  const [edgeShift, setEdgeShift] = useState(stored.edgeShift)
  const [feather, setFeather] = useState(stored.feather)
  const [defringeAmt, setDefringeAmt] = useState(stored.defringeAmt)
  const [trimPad, setTrimPad] = useState(stored.trimPad)
  // Flat-recolor target for monochrome logos (Recolor → Apply).
  const [recolorColor, setRecolorColor] = useState(stored.recolorColor)
  // Guided pins: normalized (0–1), not persisted, not in undo.
  const [markers, setMarkers] = useState<KeepRemoveMarker[]>([])

  const clearMarkers = useCallback(() => setMarkers([]), [])

  const onMarkerPlaced = useCallback((nx: number, ny: number, kind: 'keep' | 'remove') => {
    setMarkers((m) => [...m, { x: nx, y: ny, kind }])
  }, [])

  // Un-applied pixels from the last session, if they belong to this image.
  // Boxed so cleanupSeed runs once: `useRef(cleanupSeed(assetKey))` would still
  // call it (and claim from the boot payload) on every render.
  const seedBox = useRef<{ seed: ReturnType<typeof cleanupSeed> } | null>(null)
  if (!seedBox.current) seedBox.current = { seed: cleanupSeed(assetKey) }
  const seedWorking = seedBox.current.seed

  const cleanup = useCleanupCanvas({
    pz,
    tool,
    tolerance,
    softness,
    brushSize,
    defringeStrength,
    matteOn,
    matteColor,
    onMarkerPlaced,
    seedWorking,
  })
  const {
    canvasRef,
    setStage,
    ready,
    revision,
    snapshotWorking,
    undoLen,
    redoLen,
    modified,
    applied,
    aiBusy,
    aiStatus,
    aiDevice,
    status,
    brushCursor,
    spacePan,
    dims,
    scaleRef,
    handlePointerDown,
    handlePointerMove,
    endStroke,
    onCanvasPointerLeave,
    handleUndo,
    handleRedo,
    handleReset,
    handleApply,
    handleDownload,
    handleAuto,
    handleAi,
    growEdge,
    shrinkEdge,
    featherEdge,
    defringeMore,
    recolorAll,
    autoTrim,
  } = cleanup

  const isBrush = tool === 'erase' || tool === 'restore'
  const isMarker = tool === 'keep' || tool === 'remove'

  // ------------------------------------------------------------ session save
  useEffect(() => {
    saveCleanupSettings({
      viewMode,
      tool,
      tolerance,
      softness,
      brushSize,
      defringeStrength,
      ghostOpacity,
      matteOn,
      matteColor,
      edgeShift,
      feather,
      defringeAmt,
      trimPad,
      recolorColor,
    })
  }, [
    viewMode,
    tool,
    tolerance,
    softness,
    brushSize,
    defringeStrength,
    ghostOpacity,
    matteOn,
    matteColor,
    edgeShift,
    feather,
    defringeAmt,
    trimPad,
    recolorColor,
  ])

  // The cutout itself, saved on every `revision` bump. Gated on `ready` so the
  // mount pass can't store an empty buffer over the one it is about to restore.
  useEffect(() => {
    if (!ready) return
    void saveCleanupPixels(assetKey, snapshotWorking, modified)
  }, [ready, revision, modified, assetKey, snapshotWorking])

  // -------------------------------------------------- marker lifecycle clears
  // The hook owns no marker state, so pins are dropped here whenever the pixels
  // are replaced; otherwise they'd float over a different image.
  useEffect(() => {
    clearMarkers()
  }, [logo.src, clearMarkers])
  // A dims change (crop, differently-sized undo/redo) invalidates pin positions.
  const dimsKey = dims ? `${dims.w}x${dims.h}` : 'none'
  useEffect(() => {
    clearMarkers()
  }, [dimsKey, clearMarkers])

  const onReset = useCallback(() => {
    clearMarkers()
    handleReset()
  }, [clearMarkers, handleReset])
  const onApply = useCallback(() => {
    clearMarkers()
    handleApply()
  }, [clearMarkers, handleApply])
  // AI replaces the whole working buffer, so any pins now point at stale regions.
  const onAi = useCallback(() => {
    clearMarkers()
    void handleAi()
  }, [clearMarkers, handleAi])

  // ------------------------------------------------- edge-refine apply wiring
  // Shrink↔Grow: one signed slider, dispatched to grow/shrink by sign/magnitude.
  const onApplyEdgeShift = useCallback(() => {
    if (edgeShift > 0) growEdge(edgeShift)
    else if (edgeShift < 0) shrinkEdge(-edgeShift)
  }, [edgeShift, growEdge, shrinkEdge])
  const onApplyFeather = useCallback(() => {
    if (feather > 0) featherEdge(feather)
  }, [feather, featherEdge])
  const onApplyDefringe = useCallback(() => {
    if (defringeAmt > 0) defringeMore(defringeAmt)
  }, [defringeAmt, defringeMore])
  const onRecolor = useCallback(() => recolorAll(recolorColor), [recolorAll, recolorColor])
  const onAutoTrim = useCallback(() => autoTrim(trimPad), [autoTrim, trimPad])

  // ----------------------------------------------------------- matte display
  // The matte is the canvas's backgroundColor; clearing it shows the stage
  // checkerboard. `ready` re-applies it when the canvas remounts.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.style.backgroundColor = matteOn ? matteColor : ''
  }, [matteOn, matteColor, ready, viewMode, canvasRef])

  const keepCount = useMemo(() => markers.filter((m) => m.kind === 'keep').length, [markers])
  const removeCount = markers.length - keepCount

  const originalSrc = logo.originalSrc ?? logo.src

  // Below md the desktop-only split pane is unusably narrow, so fall back to the
  // single result pane (the mobile view-mode strip omits "split" entirely).
  const view: ViewMode = isMobile && viewMode === 'split' ? 'result' : viewMode

  // The canvas is hidden (not unmounted) in original view; it must also lose
  // pointer events there so the original image underneath stays interactive.
  const canvasHidden = view === 'original'

  const ringDiameter = brushSize * scaleRef.current

  // Brush ring shows only while a result-bearing pane is visible (not original),
  // and never while the mobile tool sheet is covering the canvas.
  const showBrushRing =
    isBrush && brushCursor && ready && !aiBusy && !spacePan && ringDiameter > 0 && !canvasHidden && !toolsOpen

  /* -------------------------------------------------------------- subviews */

  // The always-mounted painting canvas (see the header on why it never unmounts).
  const canvasEl = (
    <PaintingCanvas
      canvasRef={canvasRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerEnd={endStroke}
      onPointerLeave={onCanvasPointerLeave}
      aiBusy={aiBusy}
      spacePan={spacePan}
      isBrush={isBrush}
      scale={pz.scale}
    />
  )

  // One prop bag feeds both the desktop rail and the mobile tool sheet, so the
  // two render identical controls and can never drift.
  const controlProps = {
    tool,
    onToolChange: (t: CleanupTool) => setTool(t),
    tolerance,
    onTolerance: setTolerance,
    softness,
    onSoftness: setSoftness,
    brushSize,
    onBrushSize: setBrushSize,
    defringeStrength,
    onDefringeStrength: setDefringeStrength,
    keepCount,
    removeCount,
    onClearMarkers: clearMarkers,
    edgeShift,
    onEdgeShift: setEdgeShift,
    onApplyEdgeShift,
    feather,
    onFeather: setFeather,
    onApplyFeather,
    defringeAmt,
    onDefringeAmt: setDefringeAmt,
    onApplyDefringe,
    recolorColor,
    onRecolorColor: setRecolorColor,
    onRecolor,
    trimPad,
    onTrimPad: setTrimPad,
    onAutoTrim,
    matteOn,
    onMatteOn: setMatteOn,
    matteColor,
    onMatteColor: setMatteColor,
    onAuto: handleAuto,
    onAi,
    onReset,
    ready,
    aiBusy,
    aiStatus,
    aiDevice,
  }

  return (
    <div className="canvas-ui flex h-full min-h-0 shrink-0 animate-in-fade">
      <CleanupControls {...controlProps} />

      <div className="flex min-w-0 flex-1 flex-col">
        {/* ------------------------------------------ toolbar (desktop) */}
        <CleanupToolbar
          viewMode={viewMode}
          onViewMode={setViewMode}
          onUndo={handleUndo}
          onRedo={handleRedo}
          undoLen={undoLen}
          redoLen={redoLen}
          aiBusy={aiBusy}
          ghostOpacity={ghostOpacity}
          onGhostOpacity={setGhostOpacity}
          pz={pz}
          applied={applied}
          modified={modified}
          ready={ready}
          onApply={onApply}
          onDownload={() => void handleDownload()}
        />

        {/* ------------------------------------------- top strip (mobile) */}
        <CleanupTopStrip
          view={view}
          onViewMode={setViewMode}
          onUndo={handleUndo}
          onRedo={handleRedo}
          undoLen={undoLen}
          redoLen={redoLen}
          aiBusy={aiBusy}
          ghostOpacity={ghostOpacity}
          onGhostOpacity={setGhostOpacity}
          pz={pz}
        />

        {/* -------------------------------------------------------- stage */}
        <CleanupStage
          setStage={setStage}
          checkerClass={checkerClass}
          isMarker={isMarker}
          view={view}
          originalSrc={originalSrc}
          markers={markers}
          pz={pz}
          canvasHidden={canvasHidden}
          ghostOpacity={ghostOpacity}
          canvas={canvasEl}
          ready={ready}
          aiBusy={aiBusy}
          aiStatus={aiStatus}
          tool={tool}
          onDone={() => setTool('magic')}
        />

        {/* ------------------------------------------ status bar (desktop) */}
        <CleanupStatusBar status={status} dims={dims} tool={tool} />

        {/* ----------------------------------------- action bar (mobile) */}
        <CleanupActionBar
          onTools={() => setToolsOpen(true)}
          onDownload={() => void handleDownload()}
          onApply={onApply}
          applied={applied}
          modified={modified}
          aiBusy={aiBusy}
          ready={ready}
        />
      </div>

      {/* Mobile tool sheet — the full rail, in a bottom sheet. */}
      <Sheet open={toolsOpen} onClose={() => setToolsOpen(false)} title="Tools" side="bottom">
        <CleanupControlsBody {...controlProps} />
      </Sheet>

      {/* Brush-size cursor ring (follows the pointer over the canvas). */}
      {showBrushRing && (
        <div
          aria-hidden
          className="pointer-events-none fixed z-50 rounded-full border border-white shadow-[0_0_0_1px_rgba(0,0,0,0.55)]"
          style={{
            left: brushCursor.x,
            top: brushCursor.y,
            width: ringDiameter,
            height: ringDiameter,
            transform: 'translate(-50%, -50%)',
          }}
        />
      )}
    </div>
  )
}
