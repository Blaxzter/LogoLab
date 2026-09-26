// The stage's non-interactive SVG overlays: grid, selection outlines, transform box, nodes, snap guides.

import type { EditableDoc, PathItem } from '../../../lib/path/types'
import { allPaths, findItem, isGroup } from '../../../lib/path/docTree'
import { GRIPS, gripPoint, type Box } from '../../../lib/editor/transform'
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
  const paths = isGroup(item) ? allPaths(item.children) : item.kind === 'path' ? [item] : []
  return (
    <g fill="none" stroke={color} strokeWidth={width} opacity={opacity}>
      {paths.map((p) => (
        <path key={p.id} d={pathD(p)} />
      ))}
    </g>
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
