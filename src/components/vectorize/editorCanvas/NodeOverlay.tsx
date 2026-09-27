// The selected path's anchor / handle overlay, drawn as a few batched paths.

import { memo, useMemo } from 'react'
import type { PathItem } from '../../../lib/path/types'
import { pathD } from '../../vector/DocRender'
import { anchorMarksD, handleDotsD, spokesD } from '../nodeOverlay'
import { ACCENT, ACCENT_SEL, HALO } from './constants'

/**
 * The selected path's edit overlay. Widths and radii are constant screen sizes,
 * so the geometry depends only on `scale` and a pan re-renders nothing. Selected
 * and hovered nodes are drawn again on top of the resting layer, so a hover
 * doesn't rebuild the bulk path strings.
 */
export const NodeOverlay = memo(function NodeOverlay({
  item,
  scale,
  selectedNodes,
  hoveredKey,
}: {
  item: PathItem
  scale: number
  selectedNodes: ReadonlySet<string>
  hoveredKey: string | null
}) {
  const r = (px: number) => px / scale
  const spokes = useMemo(() => spokesD(item), [item])
  const base = useMemo(() => {
    const a = anchorMarksD(item, 3.75 / scale, 3.5 / scale)
    return { ...a, dots: handleDotsD(item, 3.25 / scale) }
  }, [item, scale])
  const sel = useMemo(
    () => (selectedNodes.size > 0 ? anchorMarksD(item, 3.75 / scale, 3.5 / scale, selectedNodes) : null),
    [item, scale, selectedNodes],
  )

  // Hover: one anchor or one handle dot, drawn larger on top.
  let hover: React.ReactNode = null
  if (hoveredKey) {
    const [subS, idxS, which] = hoveredKey.split(':')
    const node = item.subPaths[Number(subS)]?.nodes[Number(idxS)]
    if (node && which) {
      const h = which === 'in' ? node.hIn : node.hOut
      if (h) hover = <circle cx={h.x} cy={h.y} r={r(4.25)} fill={ACCENT_SEL} stroke={ACCENT} strokeWidth={r(1.2)} />
    } else if (node) {
      const isSel = selectedNodes.has(hoveredKey)
      const one = new Set([hoveredKey])
      const m = anchorMarksD(item, r(4.75), r(4.5), one)
      hover = (
        <path
          d={m.smooth + m.corner}
          fill={isSel ? ACCENT_SEL : HALO}
          stroke={isSel ? HALO : ACCENT_SEL}
          strokeWidth={r(1.6)}
        />
      )
    }
  }

  const d = pathD(item)
  return (
    <g style={{ pointerEvents: 'none' }}>
      {/* White halo under the accent line keeps the outline legible even
                when the path's own colour is the accent. */}
      <path d={d} fill="none" stroke={HALO} strokeOpacity={0.85} strokeWidth={r(3.5)} strokeLinejoin="round" />
      <path d={d} fill="none" stroke={ACCENT} strokeWidth={r(1.5)} strokeLinejoin="round" />
      {spokes && <path d={spokes} fill="none" stroke={ACCENT} strokeOpacity={0.55} strokeWidth={r(1)} />}
      {base.dots && <path d={base.dots} fill={HALO} stroke={ACCENT} strokeWidth={r(1.2)} />}
      <path d={base.smooth + base.corner} fill={HALO} stroke={ACCENT} strokeWidth={r(1.2)} />
      {/* Selected anchors use a warm fill (not the accent) so they stay
                visible sitting on the accent-coloured outline. */}
      {sel && <path d={sel.smooth + sel.corner} fill={ACCENT_SEL} stroke={HALO} strokeWidth={r(1.2)} />}
      {hover}
    </g>
  )
})
