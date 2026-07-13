import type { CSSProperties, ReactNode } from 'react'
import { ZoomSurface } from '../ui/ZoomSurface'
import { useLabZoom } from './LabPage'
import { HEAT_BG } from './heat'

/**
 * One labelled, zoomable panel — the labs' `.cell` + `.box`.
 *
 * The box is a {@link ZoomSurface} bound to the page's shared camera, so every panel
 * on the page pans and zooms as one: wheel-zoom toward the cursor, drag to pan,
 * double-click to reset, and (new — the hand-rolled cameras never had it) pinch on
 * touch. The three copies of `attachCam`/`clampCam`/`applyCam` are gone.
 *
 * Content is expected to fill the box (`.lab-art` sizes any child svg/img/canvas to
 * 100%); the camera scales the whole surface, so a raster and a vector panel stay in
 * lockstep — which the viewBox cameras could not do (they only drove `<svg>`, leaving
 * the `<img>` panels behind).
 */
export function Panel({
  label,
  note,
  aspect = 1,
  dark = false,
  pixelated = false,
  primary = false,
  children,
}: {
  label: ReactNode
  note?: ReactNode
  /**
   * The art's width ÷ height. The panel takes the SOURCE's shape (fitted inside the box-size
   * square), instead of forcing every image into a square.
   *
   * This is not cosmetic. A raster `<img>` stretched to a square is DISTORTED, while a trace
   * `<svg viewBox>` letterboxes itself (`preserveAspectRatio` defaults to `meet`) — so on
   * non-square art like `headphones-flat` (582×1024) the source and the trace were drawn at
   * two different scales, side by side, and could not be compared. Shaping the panel to the
   * art makes every panel in the row draw the same pixels at the same size.
   */
  aspect?: number
  /** Sit the art on the near-black heat backdrop instead of the checkerboard. */
  dark?: boolean
  /** Keep rasters crisp (nearest-neighbour) under zoom — these panels are for pixel-peeping. */
  pixelated?: boolean
  /** Registers this panel as the box the +/− buttons zoom around. Set it on the first
   *  panel of the first row; every box in a row is the same size, so one is enough. */
  primary?: boolean
  children: ReactNode
}) {
  const pz = useLabZoom()
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 1
  // Fit the art's shape inside the box-size square: the long side gets the full box.
  const size: CSSProperties =
    a >= 1
      ? { width: 'var(--lab-box)', height: `calc(var(--lab-box) / ${a})` }
      : { width: `calc(var(--lab-box) * ${a})`, height: 'var(--lab-box)' }

  return (
    <div className="flex flex-none flex-col" style={{ width: size.width }}>
      {/* flex-1: the caption absorbs the row's spare height, so the label sits at the TOP of
          every cell and the box at the BOTTOM of every cell — both stay in line even when one
          panel's note wraps to three lines and its neighbour's to one. */}
      <div className="mb-1.5 flex min-h-[3.4em] flex-1 flex-col text-[0.68rem] leading-snug text-muted">
        <b className="font-semibold text-ink">{label}</b>
        {note && <span>{note}</span>}
      </div>
      <ZoomSurface
        pz={pz}
        primary={primary}
        className={`rounded-lg border border-line-strong ${
          dark ? '' : 'checkerboard dark:checkerboard-dark'
        }`}
        style={size}
      >
        <div
          className={`lab-art h-full w-full ${pixelated ? 'pixelated' : ''}`}
          style={dark ? { background: HEAT_BG } : undefined}
        >
          {children}
        </div>
      </ZoomSurface>
    </div>
  )
}

/** Panel content from a generated SVG/HTML string (a serialized trace, an overlay). */
export function RawArt({ html }: { html: string }) {
  return <div className="contents" dangerouslySetInnerHTML={{ __html: html }} />
}
