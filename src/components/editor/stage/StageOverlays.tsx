// The stage's non-interactive SVG overlays: grid, selection outlines, transform box, nodes, snap guides.

import { useId } from 'react'
import type { EditableDoc, PathItem } from '../../../lib/path/types'
import { allPaths, findItem, isGroup } from '../../../lib/path/docTree'
import { GRIPS, gripPoint, itemBox, type Box } from '../../../lib/editor/transform'
import type { SnapCandidate } from '../../../lib/editor/snapping'
import { handleKeysFor, nodeKey } from '../../../lib/editor/nodeEdit'
import { pathD } from '../../vector/DocRender'
import { ACCENT, ACCENT_SEL, GUIDE, HALO, ROTATE_OFFSET_PX } from './stageConstants'

export function GridOverlay({
  vx,
  vy,
  vw,
  vh,
  step,
  width,
}: {
  vx: number
  vy: number
  vw: number
  vh: number
  step: number
  width: number
}) {
  const lines: React.ReactNode[] = []
  // Cap the line count so a fine grid on a large artboard stays cheap.
  const maxLines = 200
  const stepX = Math.max(step, vw / maxLines)
  const stepY = Math.max(step, vh / maxLines)
  for (let x = Math.ceil(vx / stepX) * stepX; x <= vx + vw; x += stepX) {
    lines.push(<line key={`x${x}`} x1={x} y1={vy} x2={x} y2={vy + vh} />)
  }
  for (let y = Math.ceil(vy / stepY) * stepY; y <= vy + vh; y += stepY) {
    lines.push(<line key={`y${y}`} x1={vx} y1={y} x2={vx + vw} y2={y} />)
  }
  return (
    <g stroke="#94a3b8" strokeWidth={width} opacity={0.35} style={{ pointerEvents: 'none' }}>
      {lines}
    </g>
  )
}

export function SelectionOutline({
  doc,
  id,
  width,
  color,
  opacity = 1,
}: {
  doc: EditableDoc
  id: string
  width: number
  color: string
  opacity?: number
}) {
  const item = findItem(doc.items, id)
  if (!item) return null
  // A live text is outlined by its box, as in Affinity: tracing every glyph
  // draws the contours a script face overlaps at its joins, which the fill hides.
  if (isGroup(item) && item.text) {
    const b = itemBox(item)
    return b ? (
      <rect x={b.x} y={b.y} width={b.w} height={b.h} fill="none" stroke={color} strokeWidth={width} opacity={opacity} />
    ) : null
  }
  const paths = isGroup(item) ? allPaths(item.children) : item.kind === 'path' ? [item] : []
  return (
    <g fill="none" stroke={color} strokeWidth={width} opacity={opacity}>
      {paths.map((p) => (
        <path key={p.id} d={pathD(p)} />
      ))}
    </g>
  )
}

/**
 * The hover echo: what a click would take. A fill is outlined on its edge, but
 * a stroke's centreline runs down the middle of its own ink, where a thin line
 * disappears, so a stroked path gets a rim drawn just OUTSIDE the ink instead:
 * a band wider than the stroke, masked by the stroke itself.
 */
export function HoverEcho({ doc, id, r }: { doc: EditableDoc; id: string; r: (px: number) => number }) {
  // useId's characters are not all valid inside url(#…).
  const maskId = `hover-${useId().replace(/[^\w-]/g, '')}`
  const item = findItem(doc.items, id)
  if (!item) return null
  const width = r(1.5)
  if (isGroup(item) && item.text) {
    const b = itemBox(item)
    return b ? <rect x={b.x} y={b.y} width={b.w} height={b.h} fill="none" stroke={ACCENT} strokeWidth={width} /> : null
  }
  const paths = isGroup(item) ? allPaths(item.children) : item.kind === 'path' ? [item] : []
  const stroked = paths.filter((p) => p.stroke && p.stroke.width > 0)
  const rim = r(2)

  // The mask's own extent: every stroked path's box, padded past its rim.
  let area: Box | null = null
  for (const p of stroked) {
    const b = itemBox(p)
    if (!b) continue
    const pad = p.stroke!.width / 2 + rim * 2
    const x0 = Math.min(area ? area.x : Infinity, b.x - pad)
    const y0 = Math.min(area ? area.y : Infinity, b.y - pad)
    const x1 = Math.max(area ? area.x + area.w : -Infinity, b.x + b.w + pad)
    const y1 = Math.max(area ? area.y + area.h : -Infinity, b.y + b.h + pad)
    area = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
  }
  const strokeProps = (p: PathItem, w: number, color: string) => ({
    d: pathD(p),
    fill: 'none',
    stroke: color,
    strokeWidth: w,
    strokeLinecap: p.stroke!.cap,
    strokeLinejoin: p.stroke!.join,
    strokeDasharray: p.stroke!.dash?.length ? p.stroke!.dash.join(' ') : undefined,
  })

  return (
    <g>
      {paths
        .filter((p) => !stroked.includes(p))
        .map((p) => (
          <path key={p.id} d={pathD(p)} fill="none" stroke={ACCENT} strokeWidth={width} />
        ))}
      {area && (
        <>
          <defs>
            <mask id={maskId} maskUnits="userSpaceOnUse" x={area.x} y={area.y} width={area.w} height={area.h}>
              <rect x={area.x} y={area.y} width={area.w} height={area.h} fill="#fff" />
              {stroked.map((p) => (
                <path key={p.id} {...strokeProps(p, p.stroke!.width, '#000')} />
              ))}
            </mask>
          </defs>
          <g mask={`url(#${maskId})`}>
            {stroked.map((p) => (
              <path key={p.id} {...strokeProps(p, p.stroke!.width + rim * 2, ACCENT)} />
            ))}
          </g>
        </>
      )}
    </g>
  )
}

/** What a press in the node tool would grab: an anchor, a handle or a segment. */
export type NodeHover =
  | { kind: 'anchor' | 'handle'; pathId: string; sub: number; idx: number; which?: 'in' | 'out' }
  | { kind: 'segment'; pathId: string; sub: number; seg: number }

/** The node-tool hover: a ring round the anchor or handle, or the one segment a drag would bend. */
export function NodeHoverMark({ path, hover, r }: { path: PathItem; hover: NodeHover; r: (px: number) => number }) {
  const sp = path.subPaths[hover.sub]
  if (!sp) return null
  if (hover.kind === 'segment') {
    const a = sp.nodes[hover.seg]
    const b = sp.nodes[(hover.seg + 1) % sp.nodes.length]
    if (!a || !b) return null
    const c1 = a.hOut ?? a
    const c2 = b.hIn ?? b
    return (
      <path
        d={`M${a.x} ${a.y}C${c1.x} ${c1.y} ${c2.x} ${c2.y} ${b.x} ${b.y}`}
        fill="none"
        stroke={ACCENT}
        strokeWidth={r(2.5)}
        strokeLinecap="round"
      />
    )
  }
  const node = sp.nodes[hover.idx]
  if (!node) return null
  const at = hover.kind === 'handle' ? (hover.which === 'in' ? node.hIn : node.hOut) : node
  if (!at) return null
  return (
    <circle
      cx={at.x}
      cy={at.y}
      r={r(hover.kind === 'handle' ? 6 : 7.5)}
      fill="none"
      stroke={ACCENT}
      strokeWidth={r(1.25)}
    />
  )
}

export function TransformBox({ box, r }: { box: Box; r: (px: number) => number }) {
  const size = r(7)
  const half = size / 2
  const rotY = box.y - r(ROTATE_OFFSET_PX)
  return (
    <g style={{ pointerEvents: 'none' }}>
      <rect
        x={box.x}
        y={box.y}
        width={box.w}
        height={box.h}
        fill="none"
        stroke={ACCENT}
        strokeWidth={r(1)}
        strokeDasharray={`${r(5)} ${r(4)}`}
        opacity={0.9}
      />
      {/* Rotation grip, tethered so it reads as belonging to the box. */}
      <line x1={box.x + box.w / 2} y1={box.y} x2={box.x + box.w / 2} y2={rotY} stroke={ACCENT} strokeWidth={r(1)} />
      <circle cx={box.x + box.w / 2} cy={rotY} r={r(4)} fill={HALO} stroke={ACCENT} strokeWidth={r(1.5)} />
      {GRIPS.map((g) => {
        const p = gripPoint(box, g)
        return (
          <rect
            key={g}
            x={p.x - half}
            y={p.y - half}
            width={size}
            height={size}
            fill={HALO}
            stroke={ACCENT}
            strokeWidth={r(1.5)}
          />
        )
      })}
    </g>
  )
}

export function NodeOverlay({
  path,
  nodeSel,
  r,
  penTip,
}: {
  path: PathItem
  nodeSel: ReadonlySet<string>
  r: (px: number) => number
  penTip: boolean
}) {
  const handles: React.ReactNode[] = []
  const anchors: React.ReactNode[] = []
  const visible = handleKeysFor(path, nodeSel)

  path.subPaths.forEach((sp, sub) => {
    sp.nodes.forEach((node, idx) => {
      const key = nodeKey(path.id, sub, idx)
      const selected = nodeSel.has(key)
      const showHandles = visible.has(`${sub}:${idx}`)

      if (showHandles) {
        for (const which of ['in', 'out'] as const) {
          const h = which === 'in' ? node.hIn : node.hOut
          if (!h) continue
          handles.push(
            <g key={`${key}${which}`}>
              <line x1={node.x} y1={node.y} x2={h.x} y2={h.y} stroke={ACCENT} strokeWidth={r(1)} opacity={0.8} />
              <circle cx={h.x} cy={h.y} r={r(3)} fill={ACCENT} stroke={HALO} strokeWidth={r(1)} />
            </g>,
          )
        }
      }

      // Smooth nodes draw as circles, corners as squares.
      const size = r(selected ? 4 : 3.2)
      anchors.push(
        node.kind === 'smooth' ? (
          <circle
            key={key}
            cx={node.x}
            cy={node.y}
            r={size}
            fill={selected ? ACCENT_SEL : HALO}
            stroke={selected ? HALO : ACCENT}
            strokeWidth={r(1.4)}
          />
        ) : (
          <rect
            key={key}
            x={node.x - size}
            y={node.y - size}
            width={size * 2}
            height={size * 2}
            fill={selected ? ACCENT_SEL : HALO}
            stroke={selected ? HALO : ACCENT}
            strokeWidth={r(1.4)}
          />
        ),
      )
    })
  })

  const last = penTip ? path.subPaths[0]?.nodes.at(-1) : null

  return (
    <g style={{ pointerEvents: 'none' }}>
      <path d={pathD(path)} fill="none" stroke={ACCENT} strokeWidth={r(0.9)} opacity={0.55} />
      {handles}
      {anchors}
      {last && <circle cx={last.x} cy={last.y} r={r(5.5)} fill="none" stroke={ACCENT_SEL} strokeWidth={r(1.4)} />}
    </g>
  )
}

export function SnapGuides({
  guides,
  vx,
  vy,
  vw,
  vh,
  width,
}: {
  guides: { x: SnapCandidate | null; y: SnapCandidate | null }
  vx: number
  vy: number
  vw: number
  vh: number
  width: number
}) {
  return (
    <g stroke={GUIDE} strokeWidth={width} style={{ pointerEvents: 'none' }}>
      {guides.x && <line x1={guides.x.value} y1={vy} x2={guides.x.value} y2={vy + vh} />}
      {guides.y && <line x1={vx} y1={guides.y.value} x2={vx + vw} y2={guides.y.value} />}
    </g>
  )
}
