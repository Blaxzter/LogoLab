// One pointermove of an in-flight gesture: recompute the live preview from the gesture's snapshot.

import type { EditableDoc, Vec } from '../../../lib/path/types'
import { findItem } from '../../../lib/path/docTree'
import { angleOf, rotateAbout, scaleFromGrip, snapAngle, transformItems, translation } from '../../../lib/editor/transform'
import { axisLock, snapBoxDelta, snapPoint, type SnapConfig } from '../../../lib/editor/snapping'
import { dragSegment, translateSegment } from '../../../lib/editor/segmentDrag'
import { applyNodeMove, replaceIn } from '../../../lib/editor/nodeEdit'
import { moveHandle } from '../../../lib/path/geometry'
import { DRAG_THRESHOLD_PX } from './stageConstants'
import type { Gesture, Guides } from './gesture'

export interface DragContext {
  selection: ReadonlySet<string>
  snap: SnapConfig
  r: (px: number) => number
  setGesture: (g: Gesture) => void
  setGuides: (g: Guides) => void
  onDocChange: (doc: EditableDoc) => void
}

export function dragGesture(
  gesture: Gesture,
  p: Vec,
  e: React.PointerEvent<SVGSVGElement>,
  { selection, snap, r, setGesture, setGuides, onDocChange }: DragContext,
): void {
  switch (gesture.kind) {
    case 'marquee':
      setGesture({ ...gesture, current: p })
      break

    case 'draw':
      setGesture({ ...gesture, current: p })
      break

    case 'move': {
      let delta = { x: p.x - gesture.start.x, y: p.y - gesture.start.y }
      if (e.shiftKey) delta = axisLock(delta)
      const snapped = e.metaKey || e.ctrlKey
        ? { delta, x: null, y: null }
        : snapBoxDelta(gesture.box, delta, gesture.targets, snap)
      setGuides({ x: snapped.x, y: snapped.y })
      const moved =
        gesture.moved || Math.hypot(delta.x, delta.y) > r(DRAG_THRESHOLD_PX)
      if (moved !== gesture.moved) setGesture({ ...gesture, moved })
      if (!moved) break
      onDocChange({
        ...gesture.base,
        items: transformItems(
          gesture.base.items,
          selection,
          translation(snapped.delta.x, snapped.delta.y),
        ),
      })
      break
    }

    case 'grip': {
      const target = e.metaKey || e.ctrlKey
        ? p
        : snapPoint(p, gesture.targets, snap).point
      const m = scaleFromGrip(gesture.box, gesture.grip, target, {
        uniform: e.shiftKey,
        fromCenter: e.altKey,
      })
      onDocChange({ ...gesture.base, items: transformItems(gesture.base.items, selection, m) })
      break
    }

    case 'rotate': {
      let angle = angleOf(gesture.center, p) - gesture.startAngle
      if (e.shiftKey) angle = snapAngle(angle)
      onDocChange({
        ...gesture.base,
        items: transformItems(gesture.base.items, selection, rotateAbout(gesture.center, angle)),
      })
      break
    }

    case 'nodes': {
      let delta = { x: p.x - gesture.start.x, y: p.y - gesture.start.y }
      if (e.shiftKey) delta = axisLock(delta)
      // Snap the dragged node itself, so it can land exactly on another anchor.
      if (!(e.metaKey || e.ctrlKey) && gesture.refs.length === 1) {
        const ref = gesture.refs[0]
        const item = findItem(gesture.base.items, ref.itemId)
        if (item && item.kind === 'path') {
          const n = item.subPaths[ref.sub]?.nodes[ref.idx]
          if (n) {
            const want = { x: n.x + delta.x, y: n.y + delta.y }
            const res = snapPoint(want, gesture.targets, snap)
            setGuides({ x: res.x, y: res.y })
            delta = { x: res.point.x - n.x, y: res.point.y - n.y }
          }
        }
      }
      const moved = gesture.moved || Math.hypot(delta.x, delta.y) > r(DRAG_THRESHOLD_PX)
      if (moved !== gesture.moved) setGesture({ ...gesture, moved })
      if (!moved) break
      onDocChange(applyNodeMove(gesture.base, gesture.refs, delta))
      break
    }

    case 'handle': {
      const item = findItem(gesture.base.items, gesture.itemId)
      if (!item || item.kind !== 'path') break
      onDocChange({
        ...gesture.base,
        items: replaceIn(
          gesture.base.items,
          moveHandle(item, { sub: gesture.sub, idx: gesture.idx }, gesture.which, p, gesture.mirror),
        ),
      })
      break
    }

    case 'pen-handle': {
      const item = findItem(gesture.base.items, gesture.itemId)
      if (!item || item.kind !== 'path') break
      if (Math.hypot(p.x - gesture.start.x, p.y - gesture.start.y) < r(DRAG_THRESHOLD_PX)) break
      // Dragging right after placing a point pulls out a symmetric handle.
      const sp = item.subPaths[gesture.sub]
      const node = sp.nodes[gesture.idx]
      const out = { x: p.x, y: p.y }
      const inv = { x: 2 * node.x - p.x, y: 2 * node.y - p.y }
      const nodes = sp.nodes.slice()
      nodes[gesture.idx] = { ...node, hOut: out, hIn: gesture.idx === 0 ? null : inv, kind: 'smooth' }
      const subPaths = item.subPaths.slice()
      subPaths[gesture.sub] = { ...sp, nodes }
      onDocChange({ ...gesture.base, items: replaceIn(gesture.base.items, { ...item, subPaths }) })
      break
    }

    case 'segment': {
      const item = findItem(gesture.base.items, gesture.itemId)
      if (!item || item.kind !== 'path') break
      const next = gesture.whole
        ? translateSegment(item, gesture.sub, gesture.seg, p.x - gesture.start.x, p.y - gesture.start.y)
        : dragSegment(item, gesture.sub, gesture.seg, gesture.t, gesture.from, p)
      onDocChange({ ...gesture.base, items: replaceIn(gesture.base.items, next) })
      break
    }
  }
}
