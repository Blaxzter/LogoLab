import { useEffect, useId, useMemo, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { ZoomSurface } from '../ui/ZoomSurface'
import { useLabZoom, useLabDark } from './LabPage'
import { HEAT_BG } from './heat'

/**
 * One labelled, zoomable panel — the labs' `.cell` + `.box`.
 *
 * The box is a {@link ZoomSurface} bound to its ROW's camera (CaseRow provides it), so
 * the panels of one case pan and zoom as one: wheel-zoom toward the cursor, drag to
 * pan, double-click to reset, pinch on touch. Rows are independent of each other.
 *
 * The first panel to mount under a camera claims itself as the box the row's +/−
 * buttons zoom around (every box in a row is the same size, so one is enough) — no
 * `primary` flag to thread through the labs, and it cannot be forgotten on a row.
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
  grid,
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
  /** Sit the art on the near-black heat backdrop instead of the checkerboard — forced on
   *  (heat maps must stay dark); the page-wide "Dark bg" toggle darkens the rest. */
  dark?: boolean
  /** Keep rasters crisp (nearest-neighbour) under zoom — these panels are for pixel-peeping. */
  pixelated?: boolean
  /** Overlay a SOURCE-pixel grid (w×h = the source raster) that fades in under deep zoom —
   *  a fixed reference for reading sub-pixel position shifts between panels (labs.css). */
  grid?: { w: number; h: number }
  children: ReactNode
}) {
  const { pz, claimed } = useLabZoom()
  const pageDark = useLabDark()
  const isDark = dark || pageDark
  // Claim the row's primary-viewport slot if nobody has (mount order = DOM order, so
  // this is the row's first panel). Released on unmount so a rebuilt row re-claims.
  const [primary, setPrimary] = useState(false)
  useEffect(() => {
    if (claimed.current) return undefined
    claimed.current = true
    setPrimary(true)
    return () => {
      claimed.current = false
    }
  }, [claimed])
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
          isDark ? '' : 'checkerboard dark:checkerboard-dark'
        }`}
        style={size}
      >
        <div
          className={`lab-art relative h-full w-full ${pixelated ? 'pixelated' : ''}`}
          style={isDark ? { background: HEAT_BG } : undefined}
        >
          {children}
          {grid && (
            <div
              className="pixel-grid"
              style={{ '--pg-w': grid.w, '--pg-h': grid.h } as CSSProperties}
            />
          )}
        </div>
      </ZoomSurface>
    </div>
  )
}

/**
 * Prefix every id DEFINED in an SVG fragment (and its `url(#…)` / `href="#…"` references) so
 * that inlining many generated traces into one page can't collide. Every traced doc numbers its
 * paths from `trace-0`, so `serializeDoc` gives every gradient case an `id="grad-trace-0"`; with
 * all of them in one shared DOM the browser resolves `url(#grad-trace-0)` to whichever lands
 * FIRST — so a radial-glow path renders with an earlier case's linear gradient. A per-instance
 * prefix makes each panel's ids unique. Only ids the fragment itself defines are touched, so a
 * hex fill like `#cb462f` is never mistaken for a reference.
 */
function namespaceIds(html: string, prefix: string): string {
  const ids = new Set<string>()
  const re = /\bid="([^"]+)"/g
  for (let m = re.exec(html); m; m = re.exec(html)) ids.add(m[1])
  if (ids.size === 0) return html
  let out = html
  for (const id of ids) {
    const p = `${prefix}-${id}`
    out = out.replaceAll(`id="${id}"`, `id="${p}"`)
    out = out.replaceAll(`url(#${id})`, `url(#${p})`)
    out = out.replaceAll(`href="#${id}"`, `href="#${p}"`) // covers xlink:href too
  }
  return out
}

/** Panel content from a generated SVG/HTML string (a serialized trace, an overlay). Ids are
 *  namespaced per instance so sibling panels' gradient defs never collide (see namespaceIds). */
export function RawArt({ html }: { html: string }) {
  const prefix = useId().replace(/:/g, '') // useId yields ":r0:" — colons are awkward in refs
  const scoped = useMemo(() => namespaceIds(html, prefix), [html, prefix])
  return <div className="contents" dangerouslySetInnerHTML={{ __html: scoped }} />
}
