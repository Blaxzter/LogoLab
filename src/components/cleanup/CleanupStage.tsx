// The cleanup studio's pan/zoom stage: source pane, the always-mounted painting canvas, pins and overlays.

import { Loader2, MapPin } from 'lucide-react'
import type { CleanupTool, KeepRemoveMarker } from '../../hooks/useCleanupCanvas'
import type { PanZoom } from '../../hooks/usePanZoom'
import type { ViewMode } from './CleanupToolbar'

/** Marker-pin colours, mirroring the vectorize pin glyph (green keep / red remove). */
const KEEP_FILL = '#10b981'
const REMOVE_FILL = '#ef4444'
const PIN_HALO = '#ffffff'

/**
 * The stage: split / result / original / overlay. Layered, not branched, so the
 * painting canvas (passed in as `canvas`) stays mounted in every view.
 */
export function CleanupStage({
  setStage,
  checkerClass,
  isMarker,
  view,
  originalSrc,
  markers,
  pz,
  canvasHidden,
  ghostOpacity,
  canvas,
  ready,
  aiBusy,
  aiStatus,
  tool,
  onDone,
}: {
  setStage: (el: HTMLDivElement | null) => void
  checkerClass: string
  isMarker: boolean
  view: ViewMode
  originalSrc: string | null
  markers: KeepRemoveMarker[]
  pz: PanZoom
  canvasHidden: boolean
  ghostOpacity: number
  canvas: React.ReactNode
  ready: boolean
  aiBusy: boolean
  aiStatus: string
  tool: CleanupTool
  onDone: () => void
}) {
  return (
    <div
      ref={setStage}
      className={`relative min-h-0 flex-1 overflow-hidden ${checkerClass} ${
        isMarker ? 'ring-2 ring-inset ring-emerald-400/70' : ''
      }`}
    >
      {/* Source pane: left half in split, whole stage in original. In overlay
          the source is drawn as a ghost inside the canvas host instead. */}
      {(view === 'split' || view === 'original') && (
        <div
          data-zoom-pane
          className={`absolute inset-y-0 left-0 overflow-hidden ${
            view === 'split' ? 'right-1/2 border-r border-line' : 'right-0'
          }`}
        >
          <div className="absolute inset-0 flex items-center justify-center p-4" style={pz.contentStyle}>
            <FitImage src={originalSrc} markers={markers} scale={pz.scale} />
          </div>
          <Chip>Original</Chip>
        </div>
      )}

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
        {canvas}
      </CanvasHost>

      {/* The canvas is blank until the first decode finishes. */}
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

      {/* Tells the user the canvas is now click-to-place a marker. */}
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
            {tool === 'keep' ? 'Click the image to restore that region' : 'Click the image to remove that region'}
            <button
              type="button"
              onClick={onDone}
              className="pointer-events-auto -mr-1 ml-1 rounded-full px-2 py-0.5 text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink"
            >
              Done
            </button>
          </span>
        </div>
      )}
    </div>
  )
}

/**
 * The painting <canvas>. It must never unmount: an unmounted canvas reports a
 * 0-width rect and breaks the hook's imgCoords painting math on return.
 */
export function PaintingCanvas({
  canvasRef,
  onPointerDown,
  onPointerMove,
  onPointerEnd,
  onPointerLeave,
  aiBusy,
  spacePan,
  isBrush,
  scale,
}: {
  canvasRef: React.RefObject<HTMLCanvasElement | null>
  onPointerDown: (e: React.PointerEvent<HTMLCanvasElement>) => void
  onPointerMove: (e: React.PointerEvent<HTMLCanvasElement>) => void
  onPointerEnd: (e: React.PointerEvent<HTMLCanvasElement>) => void
  onPointerLeave: () => void
  aiBusy: boolean
  spacePan: boolean
  isBrush: boolean
  scale: number
}) {
  return (
    <canvas
      ref={canvasRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onMouseDown={(e) => {
        if (e.button === 1) e.preventDefault() // suppress middle-click autoscroll while panning
      }}
      onPointerLeave={onPointerLeave}
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
        // Pixelated when magnified so individual edge pixels are visible.
        imageRendering: scale > 1 ? 'pixelated' : 'auto',
        touchAction: 'none',
      }}
    />
  )
}

/**
 * Hosts the always-mounted painting canvas: right half in split, whole stage
 * otherwise, hidden (not unmounted) in original. In overlay it stacks the ghost
 * source under the canvas. Marker pins ride in the canvas's own box so they
 * share its transform.
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
function FitImage({ src, markers, scale }: { src: string | null; markers: KeepRemoveMarker[]; scale: number }) {
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
