// The cleanup studio: a full-height workspace wiring the background-removal hot
// path (useCleanupCanvas) to a Vectorize-style shell. Left rail = removal tools,
// center = toolbar + pan/zoom stage (split / result / original / overlay views)
// + status bar. The painting <canvas> stays ALWAYS MOUNTED across view modes —
// unmounting it zeroes getBoundingClientRect().width and breaks the imgCoords
// painting math on return — so non-result views just hide it with classes.
//
// Guided keep/remove markers are studio state (normalized 0–1, not persisted,
// not in undo); the hook only flood-restores/removes the region and tells us
// where via onMarkerPlaced. We clear them whenever the working buffer changes
// shape (source swap, Reset, Apply, and any crop/undo that resizes dims).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, Download, Loader2, MapPin, Redo2, SlidersHorizontal, Undo2 } from 'lucide-react'
import { useCheckerClass, useLogo } from '../../store'
import { usePanZoom } from '../../hooks/usePanZoom'
import { useIsMobile } from '../../hooks/useIsMobile'
import { useCleanupCanvas, type CleanupTool, type KeepRemoveMarker } from '../../hooks/useCleanupCanvas'
import { ZoomControls } from '../ui/ZoomControls'
import { CheckerToggle } from '../ui/CheckerToggle'
import { Segmented } from '../ui/controls'
import { Button } from '../ui/Button'
import { Sheet } from '../ui/Sheet'
import { PopoverSlider } from '../ui/PopoverSlider'
import { StudioTopBar, StudioActionBar, BarIconButton } from '../studio/StudioBar'
import { Tooltip } from '../ui/Tooltip'
import { CleanupControls, CleanupControlsBody } from './CleanupControls'

type ViewMode = 'split' | 'result' | 'original' | 'overlay'

/** Marker-pin colours, mirroring the vectorize pin glyph (green keep / red remove). */
const KEEP_FILL = '#10b981'
const REMOVE_FILL = '#ef4444'
const PIN_HALO = '#ffffff'

export function CleanupStudio() {
  const logo = useLogo()
  const checkerClass = useCheckerClass()
  const pz = usePanZoom({ maxScale: 16 })
  const isMobile = useIsMobile()

  // ----------------------------------------------------------- studio state
  const [viewMode, setViewMode] = useState<ViewMode>('split')
  // Below md the controls live in a bottom sheet opened from the action bar.
  const [toolsOpen, setToolsOpen] = useState(false)
  const [tool, setTool] = useState<CleanupTool>('magic')
  const [tolerance, setTolerance] = useState(36)
  const [softness, setSoftness] = useState(0.25)
  const [brushSize, setBrushSize] = useState(40)
  // How hard each Magic / By color / Auto removal cleans the colored fringe off
  // soft edges (0 = off). See defringe() in bgRemove.ts.
  const [defringeStrength, setDefringeStrength] = useState(0.7)
  const [ghostOpacity, setGhostOpacity] = useState(60)
  const [matteOn, setMatteOn] = useState(false)
  const [matteColor, setMatteColor] = useState('#ffffff')
  // Edge-refine / trim slider values (the op runs on its own Apply button).
  const [edgeShift, setEdgeShift] = useState(0)
  const [feather, setFeather] = useState(2)
  const [defringeAmt, setDefringeAmt] = useState(0.9)
  const [trimPad, setTrimPad] = useState(8)
  // Flat-recolor target for monochrome logos (Recolor → Apply).
  const [recolorColor, setRecolorColor] = useState('#ffffff')
  // Guided pins: normalized (0–1), NOT persisted, NOT in undo. Cleared whenever
  // the working buffer changes shape (see the dims/src effects below).
  const [markers, setMarkers] = useState<KeepRemoveMarker[]>([])

  const clearMarkers = useCallback(() => setMarkers([]), [])

  const onMarkerPlaced = useCallback((nx: number, ny: number, kind: 'keep' | 'remove') => {
    setMarkers((m) => [...m, { x: nx, y: ny, kind }])
  }, [])

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
  })
  const {
    canvasRef,
    setStage,
    ready,
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

  // -------------------------------------------------- marker lifecycle clears
  // The hook resets working pixels on these events but owns no marker state — so
  // the pins must be dropped here, or they'd float over a different image.
  useEffect(() => {
    clearMarkers()
  }, [logo.src, clearMarkers])
  // Any dims change (crop, differently-sized undo/redo) invalidates the pins'
  // image-space meaning enough that the cleanest contract is to clear them.
  const dimsKey = dims ? `${dims.w}x${dims.h}` : 'none'
  useEffect(() => {
    clearMarkers()
  }, [dimsKey, clearMarkers])

  // Reset/Apply both call into the hook; wrap them to also drop the pins.
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
  // The canvas shows the matte behind its own transparent pixels; clearing the
  // backgroundColor reveals the stage checkerboard again. Re-applied whenever
  // the canvas (re)mounts on reload, hence the `ready` dependency.
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

  // The always-mounted painting canvas. Visibility is toggled by the caller via
  // `hidden`; never conditionally unmounted (a 0-width rect breaks imgCoords).
  const canvasEl = (
    <canvas
      ref={canvasRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endStroke}
      onPointerCancel={endStroke}
      onMouseDown={(e) => {
        if (e.button === 1) e.preventDefault() // suppress middle-click autoscroll while panning
      }}
      onPointerLeave={onCanvasPointerLeave}
      className={`max-h-full max-w-full rounded-md ${
        aiBusy
          ? 'pointer-events-none opacity-60'
          : spacePan
            ? 'cursor-grab'
            : isBrush
              ? 'cursor-none'
              : 'cursor-crosshair'
      }`}
      style={{
        width: 'auto',
        height: 'auto',
        // Crisp, blocky pixels when magnified past fit (so you can nudge
        // individual edge pixels); smooth interpolation when fit/zoomed out.
        imageRendering: pz.scale > 1 ? 'pixelated' : 'auto',
        touchAction: 'none',
      }}
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
    <div className="flex h-full min-h-0 animate-in-fade">
      <CleanupControls {...controlProps} />

      <div className="flex min-w-0 flex-1 flex-col">
        {/* ------------------------------------------ toolbar (desktop) */}
        <div className="hidden h-12 shrink-0 items-center gap-2 border-b border-line bg-surface px-3 md:flex">
          <Segmented<ViewMode>
            value={viewMode}
            onChange={setViewMode}
            options={[
              { value: 'split', label: 'Split' },
              { value: 'result', label: 'Result' },
              { value: 'original', label: 'Original' },
              { value: 'overlay', label: 'Overlay' },
            ]}
          />
          <ToolButton title="Undo (Ctrl+Z)" onClick={handleUndo} disabled={undoLen === 0 || aiBusy}>
            <Undo2 size={15} />
          </ToolButton>
          <ToolButton
            title="Redo (Ctrl+Shift+Z)"
            onClick={handleRedo}
            disabled={redoLen === 0 || aiBusy}
          >
            <Redo2 size={15} />
          </ToolButton>
          {viewMode === 'overlay' && (
            <label className="flex items-center gap-2 text-xs text-muted">
              Ghost
              <input
                type="range"
                min={0}
                max={100}
                value={ghostOpacity}
                onChange={(e) => setGhostOpacity(Number(e.target.value))}
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
              disabled={(!modified && !applied) || aiBusy || !ready}
            >
              {applied ? 'Applied ✓' : 'Apply to logo'}
            </Button>
            <Button
              variant="secondary"
              className="h-8 px-3 text-xs"
              icon={<Download size={14} />}
              onClick={() => void handleDownload()}
              disabled={aiBusy || !ready}
            >
              Download PNG
            </Button>
          </div>
        </div>

        {/* ------------------------------------------- top strip (mobile) */}
        <StudioTopBar>
          <Segmented<ViewMode>
            value={view}
            onChange={setViewMode}
            options={[
              { value: 'result', label: 'Result' },
              { value: 'original', label: 'Original' },
              { value: 'overlay', label: 'Overlay' },
            ]}
          />
          <BarIconButton title="Undo" onClick={handleUndo} disabled={undoLen === 0 || aiBusy}>
            <Undo2 size={17} />
          </BarIconButton>
          <BarIconButton title="Redo" onClick={handleRedo} disabled={redoLen === 0 || aiBusy}>
            <Redo2 size={17} />
          </BarIconButton>
          {view === 'overlay' && (
            <PopoverSlider
              title="Ghost opacity"
              value={ghostOpacity}
              min={0}
              max={100}
              onChange={setGhostOpacity}
              valueText={`${ghostOpacity}%`}
              placement="bottom"
              className="shrink-0"
            >
              Ghost
            </PopoverSlider>
          )}
          <div className="ml-auto shrink-0 pl-1">
            <ZoomControls pz={pz} />
          </div>
        </StudioTopBar>

        {/* -------------------------------------------------------- stage */}
        {/* Layered, NOT branched: the source pane(s) sit underneath a single
            always-mounted canvas host. Toggling the host's visibility per view
            keeps the painting <canvas> mounted (an unmounted canvas reports a
            0-width rect and breaks imgCoords on return). */}
        <div
          ref={setStage}
          className={`relative min-h-0 flex-1 overflow-hidden ${checkerClass} ${
            isMarker ? 'ring-2 ring-inset ring-emerald-400/70' : ''
          }`}
        >
          {/* Source pane: the original image fitted into a centered box. Occupies
              the LEFT half in split, the whole stage in original. Hidden in result;
              in overlay it's drawn as a ghost INSIDE the canvas host instead. */}
          {(view === 'split' || view === 'original') && (
            <div
              data-zoom-pane
              className={`absolute inset-y-0 left-0 overflow-hidden ${
                view === 'split' ? 'right-1/2 border-r border-line' : 'right-0'
              }`}
            >
              <div
                className="absolute inset-0 flex items-center justify-center p-4"
                style={pz.contentStyle}
              >
                <FitImage src={originalSrc} markers={markers} scale={pz.scale} />
              </div>
              <Chip>Original</Chip>
            </div>
          )}

          {/* The single canvas mount — the live result. Covers the RIGHT half in
              split, the whole stage otherwise; hidden (kept mounted) in original.
              In overlay it also stacks the ghost source under the canvas. */}
          <CanvasHost
            half={view === 'split'}
            hidden={canvasHidden}
            ghostOpacity={ghostOpacity}
            ghostSrc={view === 'overlay' ? originalSrc : null}
            contentStyle={pz.contentStyle}
            label={view === 'split' ? 'Result' : null}
            markers={markers}
            scale={pz.scale}
          >
            {canvasEl}
          </CanvasHost>

          {/* First-decode affordance: the always-mounted canvas is blank until the
              source finishes decoding, so without this the stage reads as empty. */}
          {!ready && !aiBusy && (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center gap-2 text-sm text-muted">
              <Loader2 size={16} className="animate-spin" /> Loading image…
            </div>
          )}

          {/* AI-in-progress overlay (blocks the canvas, keeps zoom/pan dead). */}
          {aiBusy && (
            <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-surface/70 backdrop-blur-sm">
              <Loader2 size={28} className="animate-spin text-accent" />
              <span className="text-sm font-medium text-ink">{aiStatus || 'Working…'}</span>
            </div>
          )}

          {/* Marker-active cue: keep/remove is armed from the rail, so this on-stage
              banner makes it obvious the canvas is now click-to-seed. */}
          {isMarker && !aiBusy && (
            <div className="animate-in-fade pointer-events-none absolute left-1/2 top-3 z-10 -translate-x-1/2">
              <span
                className={`flex items-center gap-2 rounded-full border bg-surface/90 px-3 py-1 text-xs font-medium shadow-sm backdrop-blur ${
                  tool === 'keep'
                    ? 'border-emerald-400/50 text-emerald-600 dark:text-emerald-400'
                    : 'border-red-400/50 text-red-600 dark:text-red-400'
                }`}
              >
                <MapPin size={13} />
                {tool === 'keep'
                  ? 'Click the image to restore that region'
                  : 'Click the image to remove that region'}
                <button
                  type="button"
                  onClick={() => setTool('magic')}
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
          <span className="truncate">
            {status || 'Scroll to zoom · Space- or middle-drag to pan · try AI or Auto first.'}
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-3">
            {dims && (
              <span>
                {dims.w}×{dims.h}
              </span>
            )}
            <span className="hidden sm:inline">{toolStatusHint(tool)}</span>
          </span>
        </footer>

        {/* ----------------------------------------- action bar (mobile) */}
        <StudioActionBar>
          <Button
            variant="secondary"
            className="h-10"
            icon={<SlidersHorizontal size={16} />}
            onClick={() => setToolsOpen(true)}
          >
            Tools
          </Button>
          <div className="flex-1" />
          <BarIconButton
            title="Download PNG"
            onClick={() => void handleDownload()}
            disabled={aiBusy || !ready}
          >
            <Download size={18} />
          </BarIconButton>
          <Button
            variant="primary"
            className="h-10"
            icon={applied ? <Check size={16} /> : undefined}
            onClick={onApply}
            disabled={(!modified && !applied) || aiBusy || !ready}
          >
            {applied ? 'Applied' : 'Apply'}
          </Button>
        </StudioActionBar>
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

/* ------------------------------------------------------------ subcomponents */

/** Footer hint per tool — the right-hand "how to use this tool" line. */
function toolStatusHint(tool: CleanupTool): string {
  switch (tool) {
    case 'magic':
      return 'Click to flood-remove the connected background'
    case 'color':
      return 'Click a color to remove it everywhere'
    case 'erase':
      return 'Drag to rub out pixels'
    case 'restore':
      return 'Drag to paint the original back'
    case 'keep':
      return 'Click to restore that region'
    case 'remove':
      return 'Click to remove that region'
  }
}

/**
 * Hosts the single always-mounted painting canvas, centered. Covers the right
 * half of the stage in split view, the whole stage otherwise. Hidden — not
 * unmounted — in original view so the painting rect never collapses to zero
 * width. In overlay it stacks the ghost source under the canvas; in split it
 * carries the "Result" chip. Marker pins ride in the canvas's own box so they
 * counter-scale with the same transform the canvas does.
 */
function CanvasHost({
  half,
  hidden,
  ghostOpacity,
  ghostSrc,
  contentStyle,
  label,
  markers,
  scale,
  children,
}: {
  half: boolean
  hidden: boolean
  ghostOpacity: number
  ghostSrc: string | null
  contentStyle: React.CSSProperties
  label: string | null
  markers: KeepRemoveMarker[]
  scale: number
  children: React.ReactNode
}) {
  return (
    <div
      data-zoom-pane
      className={`absolute inset-y-0 overflow-hidden ${half ? 'left-1/2 right-0' : 'inset-x-0'} ${
        hidden ? 'pointer-events-none opacity-0' : ''
      }`}
      aria-hidden={hidden}
    >
      <div className="absolute inset-0 flex items-center justify-center p-4" style={contentStyle}>
        <div className="relative">
          {ghostSrc && (
            <img
              src={ghostSrc}
              alt=""
              draggable={false}
              className="pointer-events-none absolute inset-0 h-full w-full select-none"
              style={{ opacity: ghostOpacity / 100 }}
            />
          )}
          {children}
          <MarkerPins markers={markers} scale={scale} />
        </div>
      </div>
      {label && <Chip>{label}</Chip>}
    </div>
  )
}

/**
 * The source image fitted into the centered box, matching the canvas framing so
 * split view lines up. Renders the same counter-scaled marker pins over it.
 */
function FitImage({
  src,
  markers,
  scale,
}: {
  src: string | null
  markers: KeepRemoveMarker[]
  scale: number
}) {
  if (!src) return null
  return (
    <div className="relative">
      <img
        src={src}
        alt=""
        draggable={false}
        className="pointer-events-none max-h-full max-w-full select-none rounded-md"
        style={{ width: 'auto', height: 'auto' }}
      />
      <MarkerPins markers={markers} scale={scale} />
    </div>
  )
}

/**
 * Non-interactive keep/remove pins over a pane, at normalized image coords and
 * counter-scaled by 1/pz.scale so they stay a constant screen size. Removal is
 * via Undo (pins are not click targets), mirroring the vectorize pin glyph.
 */
function MarkerPins({ markers, scale }: { markers: KeepRemoveMarker[]; scale: number }) {
  if (markers.length === 0) return null
  const inv = scale > 0 ? 1 / scale : 1
  return (
    <>
      {markers.map((m, i) => (
        <div
          key={i}
          className="pointer-events-none absolute"
          style={{
            left: `${m.x * 100}%`,
            top: `${m.y * 100}%`,
            width: 14,
            height: 14,
            borderRadius: '9999px',
            background: m.kind === 'keep' ? KEEP_FILL : REMOVE_FILL,
            border: `2px solid ${PIN_HALO}`,
            boxShadow: '0 0 0 1px rgba(0,0,0,.25)',
            transform: `translate(-50%, -50%) scale(${inv})`,
          }}
        />
      ))}
    </>
  )
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="pointer-events-none absolute left-2 top-2 z-10 rounded border border-line bg-surface/80 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted backdrop-blur">
      {children}
    </span>
  )
}

function ToolButton({
  title,
  onClick,
  disabled,
  children,
}: {
  title: string
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
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
  )
}
