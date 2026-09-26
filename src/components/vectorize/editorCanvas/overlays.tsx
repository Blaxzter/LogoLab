// Non-interactive canvas overlays: colour-locator highlight, region marker pins, ghost marker.

import type { PathItem, Vec } from '../../../lib/path/types'
import { pathD } from '../../vector/DocRender'
import { ACCENT, FLAT_MARKER, HALO, MARKER, REMOVE_MARKER } from './constants'
import type { RegionMarker } from './geometry'

/** Screen px → viewBox units at the current zoom. */
type ToUnits = (px: number) => number

/** Colour-locator highlight for the hovered palette colour. */
export function HighlightOverlay({ items, r }: { items: PathItem[]; r: ToUnits }) {
  return (
    <g style={{ pointerEvents: 'none' }}>
      {items.map((it) => (
        <g key={it.id}>
          <path d={pathD(it)} fill={HALO} fillOpacity={0.35} fillRule={it.fillRule} />
          <path
            d={pathD(it)}
            fill="none"
            stroke={HALO}
            strokeOpacity={0.9}
            strokeWidth={r(3.5)}
            strokeLinejoin="round"
          />
          <path d={pathD(it)} fill="none" stroke={ACCENT} strokeWidth={r(1.75)} strokeLinejoin="round" />
        </g>
      ))}
    </g>
  )
}

/** Region markers, drawn in every tool. Clicks are hit-tested by the svg, so the
 *  pins never intercept pointer events. */
export function MarkerPins({
  markers,
  viewBox: [vbX, vbY, vbW, vbH],
  r,
}: {
  markers: RegionMarker[]
  viewBox: readonly [number, number, number, number]
  r: ToUnits
}) {
  return (
    <g style={{ pointerEvents: 'none' }}>
      {markers.map((m, i) => {
        const cx = vbX + m.x * vbW
        const cy = vbY + m.y * vbH
        const col = m.remove ? REMOVE_MARKER : m.flat ? FLAT_MARKER : MARKER
        return (
          <g key={i}>
            <circle cx={cx} cy={cy} r={r(6.5)} fill={col} fillOpacity={0.22} stroke="none" />
            <circle cx={cx} cy={cy} r={r(4)} fill={col} stroke={HALO} strokeWidth={r(1.5)} />
            {m.remove ? (
              // "×" glyph reads as remove/dissolve.
              <path
                d={`M${cx - r(1.6)} ${cy - r(1.6)} L${cx + r(1.6)} ${cy + r(1.6)} M${cx + r(1.6)} ${cy - r(1.6)} L${cx - r(1.6)} ${cy + r(1.6)}`}
                stroke={HALO}
                strokeWidth={r(1)}
                strokeLinecap="round"
                fill="none"
              />
            ) : (
              <circle cx={cx} cy={cy} r={r(1.4)} fill={HALO} />
            )}
          </g>
        )
      })}
    </g>
  )
}

/** Ghost marker: the pin the next click will drop, at exactly the point a click stores. */
export function GhostMarker({ pt, markMode, r }: { pt: Vec; markMode: 'separate' | 'flat' | 'remove'; r: ToUnits }) {
  // Ghost-marker colour tracks the active mark mode.
  const GHOST_COL = markMode === 'remove' ? REMOVE_MARKER : markMode === 'flat' ? FLAT_MARKER : MARKER
  return (
    <g style={{ pointerEvents: 'none' }} opacity={0.85}>
      <circle cx={pt.x} cy={pt.y} r={r(6.5)} fill={GHOST_COL} fillOpacity={0.18} stroke="none" />
      <circle
        cx={pt.x}
        cy={pt.y}
        r={r(4)}
        fill={GHOST_COL}
        stroke={HALO}
        strokeWidth={r(1.5)}
        strokeDasharray={`${r(2)} ${r(1.5)}`}
      />
      {/* Crosshair at the exact stored point. */}
      <path
        d={`M${pt.x - r(9)} ${pt.y} H${pt.x + r(9)} M${pt.x} ${pt.y - r(9)} V${pt.y + r(9)}`}
        stroke={GHOST_COL}
        strokeWidth={r(0.75)}
        fill="none"
      />
      <circle cx={pt.x} cy={pt.y} r={r(0.9)} fill={HALO} />
    </g>
  )
}
