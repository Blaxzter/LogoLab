// The editor canvas: rendering, hit-testing and every pointer gesture.
//
// PAN VS EDIT. The stage sits inside a ZoomSurface that pans on a left drag and
// zooms on the wheel. Rather than fight it, the stage decides per pointerdown
// who owns the gesture and stops propagation only when it takes it — so holding
// Space, using the middle button, or picking the Pan tool lets the event reach
// the surface underneath and pans, and everything else edits. That is the whole
// mechanism, and it is why panning never steals a drag that was meant to move a
// shape (and vice versa).
//
// SCREEN-CONSTANT CHROME. Handles, grips and hit radii are specified in SCREEN
// pixels and converted to viewBox units through `upp` (units per screen pixel),
// which folds in both the fitted-box scale and the live zoom. A grab radius that
// is constant in viewBox units would be unusably small zoomed out and absurdly
// large zoomed in; this way an 9px target is 9px at every zoom level.
//
// DRAGS ARE COMPUTED FROM A SNAPSHOT. Every gesture stores the document as it
// was at pointerdown and recomputes the whole result from the cumulative
// pointer delta, never from the previous frame. Incremental application is how
// drags accumulate floating-point drift and how a snapped drag gets stuck to
// its own snap.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DocItem, EditableDoc, GroupItem, PathItem, Vec } from '../../lib/path/types'
import { findItem, isGroup, allPaths } from '../../lib/path/docTree'
import {
  GRIPS,
  angleOf,
  gripPoint,
  rotateAbout,
  scaleFromGrip,
  selectionBox,
  snapAngle,
  transformItems,
  translation,
  type Box,
  type Grip,
} from '../../lib/editor/transform'
import {
  boxFromPoints,
  marqueeItems,
  marqueeNodes,
  pickItem,
  pickNodePart,
} from '../../lib/editor/hitTest'
import {
  axisLock,
  collectTargets,
  snapBoxDelta,
  snapPoint,
  type SnapCandidate,
  type SnapConfig,
  type SnapTargets,
} from '../../lib/editor/snapping'
import { dragSegment, translateSegment } from '../../lib/editor/segmentDrag'
import { moveHandle, moveNodes, setNodeKind, insertNode } from '../../lib/path/geometry'
import { boxRadius, ellipseShape, lineShape, polygonShape, rectShape, starShape } from '../../lib/editor/shapes'
import { ZoomSurface } from '../ui/ZoomSurface'
import type { PanZoom } from '../../hooks/usePanZoom'
import { useFitBox } from '../vectorize/useFitBox'
import { ItemsView, pathD } from '../vector/DocRender'
import { makePath } from './editorDoc'
import type { EditorTool } from './tools'

/* ------------------------------------------------------------- constants */

const ACCENT = '#5b5bd6'
const ACCENT_SEL = '#f25f2e'
const GUIDE = '#e11d8f'
const HALO = '#ffffff'

/** Screen-pixel hit radii. Generous on purpose: see the file header. */
const ANCHOR_PX = 9
const HANDLE_PX = 8
const SEGMENT_PX = 7
const GRIP_PX = 9
const ITEM_TOL_PX = 3
/** Movement before a pointerdown counts as a drag rather than a click. */
const DRAG_THRESHOLD_PX = 3
/** Rotation grip offset above the transform box. */
const ROTATE_OFFSET_PX = 22

/**
 * What each grip's cursor says it will do. Without these every grip reads as
 * "move", which is how a scale handle sitting on top of the artwork gets
 * mistaken for a node.
 */
const GRIP_CURSOR: Record<Grip | 'rotate', string> = {
  nw: 'nwse-resize',
  se: 'nwse-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
  rotate: 'grab',
}

/** Coarse pointers (touch) need bigger everything. */
const COARSE =
  typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches === true
const HIT = COARSE ? 1.8 : 1

/* ------------------------------------------------------------ node keys */

/** A node's identity across the whole document. */
export const nodeKey = (itemId: string, sub: number, idx: number) => `${itemId}|${sub}|${idx}`

export function parseNodeKey(key: string): { itemId: string; sub: number; idx: number } {
  const i = key.lastIndexOf('|')
  const j = key.lastIndexOf('|', i - 1)
  return {
    itemId: key.slice(0, j),
    sub: Number(key.slice(j + 1, i)),
    idx: Number(key.slice(i + 1)),
  }
}

/* --------------------------------------------------------------- gestures */

type Gesture =
  | { kind: 'marquee'; start: Vec; current: Vec; additive: boolean }
  | { kind: 'move'; start: Vec; base: EditableDoc; box: Box; targets: SnapTargets; moved: boolean }
  | { kind: 'grip'; grip: Grip; start: Vec; base: EditableDoc; box: Box; targets: SnapTargets }
  | { kind: 'rotate'; base: EditableDoc; center: Vec; startAngle: number }
  | {
      kind: 'nodes'
      start: Vec
      base: EditableDoc
      refs: { itemId: string; sub: number; idx: number }[]
      targets: SnapTargets
      moved: boolean
    }
  | {
      kind: 'handle'
      start: Vec
      base: EditableDoc
      itemId: string
      sub: number
      idx: number
      which: 'in' | 'out'
      mirror: boolean
    }
  | {
      kind: 'segment'
      start: Vec
      base: EditableDoc
      itemId: string
      sub: number
      seg: number
      t: number
      from: Vec
      whole: boolean
    }
  | { kind: 'draw'; start: Vec; current: Vec }
  | { kind: 'pen-handle'; start: Vec; base: EditableDoc; itemId: string; sub: number; idx: number }

export interface EditorStageProps {
  doc: EditableDoc
  pz: PanZoom
  tool: EditorTool
  selection: ReadonlySet<string>
  nodeSel: ReadonlySet<string>
  snap: SnapConfig
  /** Show the alignment grid. */
  showGrid: boolean
  /** Transparency backdrop class for the artboard. */
  checkerClass: string
  /** The path the pen tool is currently extending, if any. */
  penPathId: string | null
  onSelectionChange: (ids: Set<string>) => void
  onNodeSelChange: (keys: Set<string>) => void
  /** Live preview during a drag — not committed to history. */
  onDocChange: (doc: EditableDoc) => void
  /** Final state at the end of a gesture — pushed to history. */
  onDocCommit: (doc: EditableDoc) => void
  onPenPathChange: (id: string | null) => void
  /** A drawing tool finished; the studio switches back to Select. */
  onToolDone: () => void
  /** Double-clicking a group enters it so its children become selectable. */
  enteredGroupId: string | null
  onEnterGroup: (id: string | null) => void
}

export function EditorStage({
  doc,
  pz,
  tool,
  selection,
  nodeSel,
  snap,
  showGrid,
  checkerClass,
  penPathId,
  onSelectionChange,
  onNodeSelChange,
  onDocChange,
  onDocCommit,
  onPenPathChange,
  onToolDone,
  enteredGroupId,
  onEnterGroup,
}: EditorStageProps) {
  const [vx, vy, vw, vh] = doc.viewBox
  const { parentRef, width: boxW, height: boxH } = useFitBox(vw, vh)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const [gesture, setGesture] = useState<Gesture | null>(null)
  const [guides, setGuides] = useState<{ x: SnapCandidate | null; y: SnapCandidate | null }>({
    x: null,
    y: null,
  })
  const [spaceHeld, setSpaceHeld] = useState(false)
  const [hoverId, setHoverId] = useState<string | null>(null)
  const [hoverGrip, setHoverGrip] = useState<Grip | 'rotate' | null>(null)

  /** ViewBox units per screen pixel — the whole chrome-sizing story. */
  const upp = vw / Math.max(1, boxW * pz.scale)
  const r = useCallback((px: number) => px * upp, [upp])

  // Space-to-pan. Tracked at the window so it works wherever the pointer is,
  // and released on blur so alt-tabbing away can't leave it stuck on.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !isTypingTarget(e.target)) {
        e.preventDefault()
        setSpaceHeld(true)
      }
    }
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpaceHeld(false)
    }
    const blur = () => setSpaceHeld(false)
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
  }, [])

  /* ------------------------------------------------------ coordinates */

  const toDoc = useCallback(
    (e: { clientX: number; clientY: number }): Vec => {
      const rect = svgRef.current?.getBoundingClientRect()
      if (!rect || rect.width === 0) return { x: 0, y: 0 }
      return {
        x: vx + ((e.clientX - rect.left) / rect.width) * vw,
        y: vy + ((e.clientY - rect.top) / rect.height) * vh,
      }
    },
    [vx, vy, vw, vh],
  )

  /* ----------------------------------------------------- derived state */

  const box = useMemo(() => selectionBox(doc.items, selection), [doc.items, selection])

  /** The one path node-editing applies to, when exactly one path is selected. */
  const activePath = useMemo((): PathItem | null => {
    if (selection.size !== 1) return null
    const item = findItem(doc.items, [...selection][0])
    return item && item.kind === 'path' ? item : null
  }, [doc.items, selection])

  /** Paths whose nodes the node tool shows: the selection, or all when empty. */
  const nodePaths = useMemo((): PathItem[] => {
    if (tool !== 'node') return []
    if (selection.size === 0) return allPaths(doc.items).filter((p) => p.visible)
    const out: PathItem[] = []
    for (const id of selection) {
      const item = findItem(doc.items, id)
      if (!item) continue
      if (isGroup(item)) out.push(...allPaths(item.children))
      else if (item.kind === 'path') out.push(item)
    }
    return out
  }, [tool, selection, doc.items])

  const isDrawTool =
    tool === 'rect' || tool === 'ellipse' || tool === 'line' || tool === 'polygon' || tool === 'star'

  /* ------------------------------------------------------- shape build */

  const buildShape = useCallback(
    (a: Vec, b: Vec, shift: boolean): PathItem | null => {
      let pa = a
      let pb = b
      if (shift && tool !== 'line') {
        // Constrain to a square box, keeping the drag's direction.
        const s = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y))
        pb = { x: a.x + Math.sign(b.x - a.x || 1) * s, y: a.y + Math.sign(b.y - a.y || 1) * s }
      }
      let sp
      switch (tool) {
        case 'rect':
          sp = rectShape(pa, pb)
          break
        case 'ellipse':
          sp = ellipseShape(pa, pb)
          break
        case 'line': {
          if (shift) pb = { x: b.x, y: a.y === b.y ? b.y : constrainLine(a, b).y }
          sp = lineShape(pa, shift ? constrainLine(a, b) : pb)
          break
        }
        case 'polygon': {
          const { center, radius } = boxRadius(pa, pb)
          sp = polygonShape(center, radius, 6)
          break
        }
        case 'star': {
          const { center, radius } = boxRadius(pa, pb)
          sp = starShape(center, radius, 5, 0.45)
          break
        }
        default:
          return null
      }
      if (!sp || sp.length === 0) return null
      const item = makePath(sp)
      // A line has no interior, so it is born stroked rather than filled —
      // a filled zero-area path would be invisible and read as a no-op.
      if (tool === 'line') {
        item.fill = 'none'
        item.stroke = { color: '#111827', width: Math.max(1, vw / 256), cap: 'round', join: 'round' }
      }
      return item
    },
    [tool, vw],
  )

  /* ---------------------------------------------------------- pointers */

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    // Let the ZoomSurface underneath have it: explicit pan requests only.
    if (spaceHeld || e.button === 1 || tool === 'pan') return
    if (e.button !== 0) return

    const p = toDoc(e)
    const additive = e.shiftKey
    e.stopPropagation()
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* capture unavailable */
    }

    /* ---- pen: build a path click by click ---- */
    if (tool === 'pen') {
      handlePenDown(p, e)
      return
    }

    /* ---- drawing tools: rubber-band a new shape ---- */
    if (isDrawTool) {
      setGesture({ kind: 'draw', start: p, current: p })
      return
    }

    /* ---- transform box grips (select tool, something selected) ---- */
    if (tool === 'select' && box) {
      const grip = hitGrip(box, p, r(GRIP_PX * HIT))
      if (grip) {
        setGesture({
          kind: 'grip',
          grip,
          start: p,
          base: doc,
          box,
          targets: collectTargets(doc.items, doc.viewBox, selection, snap),
        })
        return
      }
      if (hitRotate(box, p, r(GRIP_PX * HIT), r(ROTATE_OFFSET_PX))) {
        setGesture({
          kind: 'rotate',
          base: doc,
          center: { x: box.x + box.w / 2, y: box.y + box.h / 2 },
          startAngle: angleOf({ x: box.x + box.w / 2, y: box.y + box.h / 2 }, p),
        })
        return
      }
    }

    /* ---- node tool: handles, anchors, then the curve ---- */
    if (tool === 'node') {
      for (const path of nodePaths) {
        const hit = pickNodePart(path, p, {
          anchorTol: r(ANCHOR_PX * HIT),
          handleTol: r(HANDLE_PX * HIT),
          segmentTol: r(SEGMENT_PX * HIT),
          handlesVisibleFor: handleKeysFor(path, nodeSel),
        })
        if (!hit) continue

        if (hit.kind === 'handle') {
          setGesture({
            kind: 'handle',
            start: p,
            base: doc,
            itemId: path.id,
            sub: hit.sub!,
            idx: hit.idx!,
            which: hit.handle!,
            // Alt breaks the smooth constraint for this drag only, which is how
            // you put a cusp in a curve without converting the node first.
            mirror: !e.altKey,
          })
          return
        }
        if (hit.kind === 'anchor') {
          const key = nodeKey(path.id, hit.sub!, hit.idx!)
          let next: Set<string>
          if (additive) {
            next = new Set(nodeSel)
            if (next.has(key)) next.delete(key)
            else next.add(key)
          } else {
            next = nodeSel.has(key) ? new Set(nodeSel) : new Set([key])
          }
          onNodeSelChange(next)
          if (!selection.has(path.id)) onSelectionChange(new Set([path.id]))
          setGesture({
            kind: 'nodes',
            start: p,
            base: doc,
            refs: [...next].map(parseNodeKey),
            targets: collectTargets(doc.items, doc.viewBox, new Set([path.id]), snap),
            moved: false,
          })
          return
        }
        if (hit.kind === 'segment') {
          if (!selection.has(path.id)) onSelectionChange(new Set([path.id]))
          setGesture({
            kind: 'segment',
            start: p,
            base: doc,
            itemId: path.id,
            sub: hit.sub!,
            seg: hit.seg!,
            t: hit.t!,
            from: hit.point!,
            // Alt slides the whole segment instead of bending it.
            whole: e.altKey,
          })
          return
        }
      }
      // Nothing under the pointer — rubber-band select nodes.
      if (!additive) onNodeSelChange(new Set())
      setGesture({ kind: 'marquee', start: p, current: p, additive })
      return
    }

    /* ---- select tool ---- */
    const hit = pickItem(doc.items, p, r(ITEM_TOL_PX * HIT), {
      groupsAreAtomic: enteredGroupId === null,
    })
    if (!hit) {
      if (!additive) {
        onSelectionChange(new Set())
        onEnterGroup(null)
      }
      setGesture({ kind: 'marquee', start: p, current: p, additive })
      return
    }

    // Inside an entered group, resolve to the leaf; outside, to the group.
    const targetId = resolveTarget(doc, hit, enteredGroupId)
    let nextSel: Set<string>
    if (additive) {
      nextSel = new Set(selection)
      if (nextSel.has(targetId)) nextSel.delete(targetId)
      else nextSel.add(targetId)
    } else {
      nextSel = selection.has(targetId) ? new Set(selection) : new Set([targetId])
    }
    onSelectionChange(nextSel)

    const moveBox = selectionBox(doc.items, nextSel)
    if (moveBox) {
      setGesture({
        kind: 'move',
        start: p,
        base: doc,
        box: moveBox,
        targets: collectTargets(doc.items, doc.viewBox, nextSel, snap),
        moved: false,
      })
    }
  }

  const handlePenDown = (p: Vec, e: React.PointerEvent<SVGSVGElement>) => {
    const snapped = snap.enabled
      ? snapPoint(p, collectTargets(doc.items, doc.viewBox, new Set(penPathId ? [penPathId] : []), snap), snap).point
      : p

    if (!penPathId) {
      const item = makePath([{ nodes: [{ ...snapped, hIn: null, hOut: null, kind: 'corner' }], closed: false }])
      item.fill = 'none'
      item.stroke = { color: '#111827', width: Math.max(1, vw / 256), cap: 'round', join: 'round' }
      const next = { ...doc, items: [...doc.items, item] }
      onDocCommit(next)
      onPenPathChange(item.id)
      onSelectionChange(new Set([item.id]))
      setGesture({ kind: 'pen-handle', start: p, base: next, itemId: item.id, sub: 0, idx: 0 })
      return
    }

    const item = findItem(doc.items, penPathId)
    if (!item || item.kind !== 'path') {
      onPenPathChange(null)
      return
    }
    const sp = item.subPaths[0]
    const first = sp.nodes[0]
    // Clicking the first node closes the loop and ends the path.
    if (sp.nodes.length > 2 && Math.hypot(first.x - p.x, first.y - p.y) <= r(ANCHOR_PX * HIT)) {
      const closed: PathItem = {
        ...item,
        subPaths: [{ ...sp, closed: true }],
        fill: item.fill === 'none' ? '#4f46e5' : item.fill,
      }
      delete closed.stroke
      onDocCommit({ ...doc, items: replaceIn(doc.items, closed) })
      onPenPathChange(null)
      onToolDone()
      return
    }

    const nodes = [...sp.nodes, { ...snapped, hIn: null, hOut: null, kind: 'corner' as const }]
    const next: PathItem = { ...item, subPaths: [{ ...sp, nodes }] }
    const nextDoc = { ...doc, items: replaceIn(doc.items, next) }
    onDocCommit(nextDoc)
    setGesture({
      kind: 'pen-handle',
      start: p,
      base: nextDoc,
      itemId: item.id,
      sub: 0,
      idx: nodes.length - 1,
    })
  }

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const p = toDoc(e)
    if (!gesture) {
      if (tool === 'select') {
        // Grips first: they sit ON the artwork (the north grip lands exactly on
        // a chevron's apex), so without this the cursor would say "move" while
        // a press would actually scale.
        const grip = box ? hitGrip(box, p, r(GRIP_PX * HIT)) : null
        const onRotate =
          box && !grip && hitRotate(box, p, r(GRIP_PX * HIT), r(ROTATE_OFFSET_PX))
        setHoverGrip(grip ?? (onRotate ? 'rotate' : null))
        if (grip || onRotate) {
          if (hoverId) setHoverId(null)
          return
        }
        const hit = pickItem(doc.items, p, r(ITEM_TOL_PX * HIT), {
          groupsAreAtomic: enteredGroupId === null,
        })
        setHoverId(hit ? resolveTarget(doc, hit, enteredGroupId) : null)
      } else {
        if (hoverId) setHoverId(null)
        if (hoverGrip) setHoverGrip(null)
      }
      return
    }
    e.stopPropagation()

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
        // Node drags snap the DRAGGED NODE itself, so a single node can land
        // exactly on a neighbour's anchor — the gap-closing move.
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
        // Dragging straight after placing a point pulls a symmetric handle out
        // of it — the standard pen gesture that draws curves in one motion.
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

  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!gesture) return
    e.stopPropagation()
    const p = toDoc(e)
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* already released */
    }

    switch (gesture.kind) {
      case 'marquee': {
        const band = boxFromPoints(gesture.start, gesture.current)
        if (band.w < r(2) && band.h < r(2)) break
        if (tool === 'node') {
          const keys = new Set(gesture.additive ? nodeSel : [])
          for (const path of nodePaths) {
            for (const k of marqueeNodes(path, band)) keys.add(nodeKey(path.id, ...splitKey(k)))
          }
          onNodeSelChange(keys)
        } else {
          const found = marqueeItems(doc.items, band, {
            groupsAreAtomic: enteredGroupId === null,
          })
          const next = new Set(gesture.additive ? selection : [])
          for (const id of found) next.add(id)
          onSelectionChange(next)
        }
        break
      }

      case 'draw': {
        const item = buildShape(gesture.start, gesture.current, e.shiftKey)
        if (item) {
          onDocCommit({ ...doc, items: [...doc.items, item] })
          onSelectionChange(new Set([item.id]))
          onToolDone()
        }
        break
      }

      case 'move':
      case 'grip':
      case 'rotate':
      case 'nodes':
      case 'handle':
      case 'segment':
      case 'pen-handle':
        // The live preview already produced the final document; commit it so
        // the whole gesture becomes ONE undo step rather than a hundred.
        onDocCommit(doc)
        break
    }
    setGesture(null)
    setGuides({ x: null, y: null })
  }

  /** Escape abandons an in-flight gesture and restores the pre-drag document. */
  useEffect(() => {
    if (!gesture) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      if ('base' in gesture) onDocChange(gesture.base)
      setGesture(null)
      setGuides({ x: null, y: null })
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [gesture, onDocChange])

  /* ------------------------------------------------------ double click */

  const onDoubleClick = (e: React.MouseEvent<SVGSVGElement>) => {
    // Always ours: the ZoomSurface below resets the zoom on double-click, which
    // would be a startling thing to happen while editing a node.
    e.stopPropagation()
    const p = toDoc(e)

    if (tool === 'node') {
      for (const path of nodePaths) {
        const hit = pickNodePart(path, p, {
          anchorTol: r(ANCHOR_PX * HIT),
          handleTol: r(HANDLE_PX * HIT),
          segmentTol: r(SEGMENT_PX * HIT),
        })
        if (!hit) continue
        if (hit.kind === 'anchor') {
          const node = path.subPaths[hit.sub!].nodes[hit.idx!]
          onDocCommit({
            ...doc,
            items: replaceIn(
              doc.items,
              setNodeKind(path, { sub: hit.sub!, idx: hit.idx! }, node.kind === 'smooth' ? 'corner' : 'smooth'),
            ),
          })
          return
        }
        if (hit.kind === 'segment') {
          onDocCommit({
            ...doc,
            items: replaceIn(doc.items, insertNode(path, hit.sub!, hit.seg!, hit.t!)),
          })
          return
        }
      }
      return
    }

    // Select tool: double-click enters a group so its children are selectable.
    const hit = pickItem(doc.items, p, r(ITEM_TOL_PX * HIT), { groupsAreAtomic: true })
    if (hit && hit.id !== hit.leafId) {
      onEnterGroup(hit.id)
      onSelectionChange(new Set([hit.leafId]))
    } else if (!hit) {
      onEnterGroup(null)
    }
  }

  /* ---------------------------------------------------------- rendering */

  const marqueeBox =
    gesture?.kind === 'marquee' ? boxFromPoints(gesture.start, gesture.current) : null
  const drawPreview =
    gesture?.kind === 'draw' ? buildShape(gesture.start, gesture.current, false) : null

  const cursor =
    spaceHeld || tool === 'pan'
      ? 'grab'
      : tool === 'pen' || isDrawTool
        ? 'crosshair'
        : hoverGrip
          ? GRIP_CURSOR[hoverGrip]
          : hoverId
            ? 'move'
            : 'default'

  const gridStep = snap.grid > 0 ? snap.grid : 0

  return (
    <div ref={parentRef} className="relative h-full w-full">
      <ZoomSurface pz={pz} primary className="h-full w-full">
        <div className="flex h-full w-full items-center justify-center">
          <div
            className={`relative shadow-sm ${checkerClass}`}
            style={{ width: boxW || 1, height: boxH || 1 }}
          >
            <svg
              ref={svgRef}
              viewBox={`${vx} ${vy} ${vw} ${vh}`}
              width={boxW || 1}
              height={boxH || 1}
              className="absolute inset-0 touch-none"
              style={{ cursor }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onDoubleClick={onDoubleClick}
            >
              {/* Catcher for empty-space clicks. Transparent, so the checker
                  backdrop shows through and an artboard with no background
                  looks like what it will export as. */}
              <rect x={vx} y={vy} width={vw} height={vh} fill="transparent" />

              {showGrid && gridStep > 0 && (
                <GridOverlay vx={vx} vy={vy} vw={vw} vh={vh} step={gridStep} width={r(0.6)} />
              )}

              <g style={{ pointerEvents: 'none' }}>
                <ItemsView items={doc.items} />
              </g>

              <g style={{ pointerEvents: 'none' }}>
                {/* Hover echo, so you know what a click would take. */}
                {hoverId && !selection.has(hoverId) && !gesture && (
                  <SelectionOutline doc={doc} id={hoverId} width={r(1)} color={ACCENT} opacity={0.5} />
                )}

                {[...selection].map((id) => (
                  <SelectionOutline key={id} doc={doc} id={id} width={r(1.25)} color={ACCENT} />
                ))}

                {tool === 'select' && box && !gesture && (
                  <TransformBox box={box} r={r} />
                )}
                {tool === 'select' && box && gesture?.kind === 'move' && (
                  <TransformBox box={box} r={r} />
                )}

                {tool === 'node' &&
                  nodePaths.map((path) => (
                    <NodeOverlay
                      key={path.id}
                      path={path}
                      nodeSel={nodeSel}
                      r={r}
                      penTip={penPathId === path.id}
                    />
                  ))}

                {drawPreview && (
                  <path
                    d={pathD(drawPreview)}
                    fill={drawPreview.fill === 'none' ? 'none' : drawPreview.fill}
                    fillOpacity={0.35}
                    stroke={ACCENT}
                    strokeWidth={r(1)}
                    strokeDasharray={`${r(4)} ${r(3)}`}
                  />
                )}

                {marqueeBox && (
                  <rect
                    x={marqueeBox.x}
                    y={marqueeBox.y}
                    width={marqueeBox.w}
                    height={marqueeBox.h}
                    fill={ACCENT}
                    fillOpacity={0.08}
                    stroke={ACCENT}
                    strokeWidth={r(1)}
                    strokeDasharray={`${r(4)} ${r(3)}`}
                  />
                )}

                <SnapGuides guides={guides} vx={vx} vy={vy} vw={vw} vh={vh} width={r(1)} />
              </g>
            </svg>
          </div>
        </div>
      </ZoomSurface>
    </div>
  )
}

/* ------------------------------------------------------------- helpers */

function isTypingTarget(t: EventTarget | null): boolean {
  return (
    t instanceof HTMLElement &&
    (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')
  )
}

function splitKey(k: string): [number, number] {
  const [a, b] = k.split(':').map(Number)
  return [a, b]
}

/** Replace a path item anywhere in the tree, returning a new item list. */
function replaceIn(items: readonly DocItem[], next: PathItem): DocItem[] {
  return items.map((it) => {
    if (it.id === next.id) return next
    if (isGroup(it)) {
      const kids = replaceIn(it.children, next)
      return kids === it.children ? it : { ...it, children: kids }
    }
    return it
  })
}

/** Which id a click resolves to, given whether a group has been entered. */
function resolveTarget(
  doc: EditableDoc,
  hit: { id: string; leafId: string },
  enteredGroupId: string | null,
): string {
  if (enteredGroupId === null) return hit.id
  const entered = findItem(doc.items, enteredGroupId)
  if (entered && isGroup(entered) && containsId(entered, hit.leafId)) return hit.leafId
  return hit.id
}

function containsId(group: GroupItem, id: string): boolean {
  for (const c of group.children) {
    if (c.id === id) return true
    if (isGroup(c) && containsId(c, id)) return true
  }
  return false
}

/** Move a set of nodes that may span several paths. */
function applyNodeMove(
  base: EditableDoc,
  refs: { itemId: string; sub: number; idx: number }[],
  delta: Vec,
): EditableDoc {
  const byItem = new Map<string, { sub: number; idx: number }[]>()
  for (const ref of refs) {
    const list = byItem.get(ref.itemId) ?? []
    list.push({ sub: ref.sub, idx: ref.idx })
    byItem.set(ref.itemId, list)
  }
  let items = base.items
  for (const [itemId, list] of byItem) {
    const item = findItem(items, itemId)
    if (!item || item.kind !== 'path') continue
    items = replaceIn(items, moveNodes(item, list, delta.x, delta.y))
  }
  return items === base.items ? base : { ...base, items }
}

/** Node keys whose handles are on screen — the selected ones and their neighbours. */
function handleKeysFor(path: PathItem, nodeSel: ReadonlySet<string>): Set<string> {
  const keys = new Set<string>()
  for (let sub = 0; sub < path.subPaths.length; sub++) {
    const n = path.subPaths[sub].nodes.length
    for (let idx = 0; idx < n; idx++) {
      if (nodeSel.has(nodeKey(path.id, sub, idx))) {
        keys.add(`${sub}:${idx}`)
        // Neighbours too: the handle that shapes the segment leaving a selected
        // node lives on the NEXT node, so hiding it would make half of every
        // curve unreachable.
        keys.add(`${sub}:${(idx + 1) % n}`)
        keys.add(`${sub}:${(idx - 1 + n) % n}`)
      }
    }
  }
  return keys
}

function hitGrip(box: Box, p: Vec, tol: number): Grip | null {
  let best: Grip | null = null
  let bestD = tol
  for (const g of GRIPS) {
    const gp = gripPoint(box, g)
    const d = Math.hypot(gp.x - p.x, gp.y - p.y)
    if (d <= bestD) {
      bestD = d
      best = g
    }
  }
  return best
}

function hitRotate(box: Box, p: Vec, tol: number, offset: number): boolean {
  const c = { x: box.x + box.w / 2, y: box.y - offset }
  return Math.hypot(c.x - p.x, c.y - p.y) <= tol
}

function constrainLine(a: Vec, b: Vec): Vec {
  // Snap a line to the nearest 45°, the constraint every editor puts on Shift.
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy)
  if (len === 0) return b
  const step = Math.PI / 4
  const t = Math.round(Math.atan2(dy, dx) / step) * step
  return { x: a.x + Math.cos(t) * len, y: a.y + Math.sin(t) * len }
}

/* ----------------------------------------------------------- overlays */

function GridOverlay({
  vx, vy, vw, vh, step, width,
}: { vx: number; vy: number; vw: number; vh: number; step: number; width: number }) {
  const lines: React.ReactNode[] = []
  // Cap the line count: a fine grid on a big artboard is thousands of nodes for
  // something the eye reads as a flat tone anyway.
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

function SelectionOutline({
  doc, id, width, color, opacity = 1,
}: { doc: EditableDoc; id: string; width: number; color: string; opacity?: number }) {
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

function TransformBox({ box, r }: { box: Box; r: (px: number) => number }) {
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

function NodeOverlay({
  path, nodeSel, r, penTip,
}: { path: PathItem; nodeSel: ReadonlySet<string>; r: (px: number) => number; penTip: boolean }) {
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

      // A smooth node is a circle, a corner a square — the shape tells you what
      // the joint will do before you drag it.
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

function SnapGuides({
  guides, vx, vy, vw, vh, width,
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
