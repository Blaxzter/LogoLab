// Every pointer gesture on the stage: who owns a pointerdown, the live drag, the commit, Escape and double-click.

import { useEffect, useState } from 'react'
import type { EditableDoc, PathItem, Vec } from '../../../lib/path/types'
import { findItem, isText } from '../../../lib/path/docTree'
import { angleOf, itemBox, selectionBox, type Box, type Grip } from '../../../lib/editor/transform'
import { layoutGroup, plainText } from '../../../lib/text/edit'
import { lookupFace } from '../../../lib/text/fonts'
import { caretIndexAt, wordAt } from '../../../lib/text/layout'
import type { TextEditing } from '../studio/useTextEditing'
import {
  boxFromPoints,
  hitGrip,
  hitRotate,
  marqueeItems,
  marqueeNodes,
  pickItem,
  pickNodePart,
  resolveTarget,
} from '../../../lib/editor/hitTest'
import { collectTargets, snapPoint, type SnapConfig } from '../../../lib/editor/snapping'
import { handleKeysFor, nodeKey, parseNodeKey, replaceIn, splitKey } from '../../../lib/editor/nodeEdit'
import { insertNode, setNodeKind } from '../../../lib/path/geometry'
import { makePath } from '../editorDoc'
import type { EditorTool } from '../tools'
import { dragGesture } from './dragGesture'
import type { Gesture, Guides } from './gesture'
import { ANCHOR_PX, GRIP_PX, HANDLE_PX, HIT, ITEM_TOL_PX, ROTATE_OFFSET_PX, SEGMENT_PX } from './stageConstants'

export interface StageGestureInput {
  doc: EditableDoc
  tool: EditorTool
  selection: ReadonlySet<string>
  nodeSel: ReadonlySet<string>
  snap: SnapConfig
  penPathId: string | null
  enteredGroupId: string | null
  spaceHeld: boolean
  isDrawTool: boolean
  /** The transform box of the selection. */
  box: Box | null
  /** Paths whose nodes the node tool shows. */
  nodePaths: PathItem[]
  /** Screen pixels → viewBox units. */
  r: (px: number) => number
  toDoc: (e: { clientX: number; clientY: number }) => Vec
  buildShape: (a: Vec, b: Vec, shift: boolean) => PathItem | null
  onSelectionChange: (ids: Set<string>) => void
  onNodeSelChange: (keys: Set<string>) => void
  onDocChange: (doc: EditableDoc) => void
  onDocCommit: (doc: EditableDoc) => void
  onPenPathChange: (id: string | null) => void
  onToolDone: () => void
  onEnterGroup: (id: string | null) => void
  /** Open one path for node editing (Affinity / Photoshop: double-click a shape); a text opens for typing at `at`. */
  onEditNodes: (id: string, at?: Vec) => void
  text: TextEditing
  /** Leave node editing for the Move tool, keeping the selection. */
  onExitNodes: () => void
}

export function useStageGestures({
  doc,
  tool,
  selection,
  nodeSel,
  snap,
  penPathId,
  enteredGroupId,
  spaceHeld,
  isDrawTool,
  box,
  nodePaths,
  r,
  toDoc,
  buildShape,
  onSelectionChange,
  onNodeSelChange,
  onDocChange,
  onDocCommit,
  onPenPathChange,
  onToolDone,
  onEnterGroup,
  onEditNodes,
  onExitNodes,
  text,
}: StageGestureInput) {
  const [gesture, setGesture] = useState<Gesture | null>(null)
  const [guides, setGuides] = useState<Guides>({
    x: null,
    y: null,
  })
  const [hoverId, setHoverId] = useState<string | null>(null)
  const [hoverGrip, setHoverGrip] = useState<Grip | 'rotate' | null>(null)
  /** The pointer is over the open text — the only place the I-beam belongs while typing. */
  const [hoverText, setHoverText] = useState(false)
  const vw = doc.viewBox[2]

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

    /* ---- the open text: a click places the caret, a drag selects ---- */
    if (text.edit && text.layout) {
      if (overOpenText(p)) {
        const idx = caretIndexAt(text.layout.carets, p)
        const anchor = e.shiftKey ? text.edit.anchor : idx
        text.setRange(anchor, idx)
        setGesture({ kind: 'text-select', anchor })
        return
      }
      // A click outside finishes typing. With the Text tool that is ALL it
      // does — the text is deselected, and the NEXT click starts a new one —
      // rather than closing this text and opening an empty one in one go.
      text.end()
      if (tool === 'text') {
        onSelectionChange(new Set())
        return
      }
    }

    /* ---- text tool: type into a text, along a shape, or somewhere new ---- */
    if (tool === 'text') {
      const hit = pickItem(doc.items, p, r(ITEM_TOL_PX * HIT), { groupsAreAtomic: false })
      const it = hit ? findItem(doc.items, hit.leafId) : null
      if (it && isText(it)) text.begin(it.id, caretIndexAt(layoutGroup(it, lookupFace).layout.carets, p))
      else if (it && it.kind === 'path') text.create(p, it.id)
      else text.create(p)
      return
    }

    /* ---- pen: build a path click by click ---- */
    if (tool === 'pen') {
      handlePenDown(p)
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
      // A click on another shape moves node editing to it, as in Affinity:
      // no trip back to the Move tool to pick the next path. Shift-click adds
      // it to (or takes it out of) the shapes being edited, nodes kept.
      const other = pickItem(doc.items, p, r(ITEM_TOL_PX * HIT), { groupsAreAtomic: false })
      const otherItem = other ? findItem(doc.items, other.leafId) : null
      if (other && otherItem?.kind === 'path') {
        if (additive) {
          const next = new Set(selection)
          if (next.has(other.leafId)) {
            next.delete(other.leafId)
            onNodeSelChange(new Set([...nodeSel].filter((k) => parseNodeKey(k).itemId !== other.leafId)))
          } else next.add(other.leafId)
          onSelectionChange(next)
          return
        }
        if (!selection.has(other.leafId)) {
          onNodeSelChange(new Set())
          onSelectionChange(new Set([other.leafId]))
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

  /** Over the open text (its box, or the caret of an empty one): where a click edits it. */
  const overOpenText = (p: Vec): boolean => {
    if (!text.edit || !text.layout) return false
    const open = findItem(doc.items, text.edit.id)
    const b = open ? itemBox(open) : null
    const pad = r(ITEM_TOL_PX * HIT)
    if (b && p.x >= b.x - pad && p.x <= b.x + b.w + pad && p.y >= b.y - pad && p.y <= b.y + b.h + pad) return true
    // An empty text has no box yet: its caret is the target.
    const c = text.layout.carets[caretIndexAt(text.layout.carets, p)]
    return (
      !!c &&
      Math.hypot(p.x - c.top.x, p.y - (c.top.y + c.bottom.y) / 2) <=
        Math.hypot(c.bottom.x - c.top.x, c.bottom.y - c.top.y)
    )
  }

  const handlePenDown = (p: Vec) => {
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
      const onText = overOpenText(p)
      if (onText !== hoverText) setHoverText(onText)
      if (tool === 'select') {
        // Grips first, matching pointerdown: they can sit on the artwork, and
        // the cursor must show what a press would actually do.
        const grip = box ? hitGrip(box, p, r(GRIP_PX * HIT)) : null
        const onRotate = box && !grip && hitRotate(box, p, r(GRIP_PX * HIT), r(ROTATE_OFFSET_PX))
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
    if (gesture.kind === 'text-select') {
      if (text.layout) text.setRange(gesture.anchor, caretIndexAt(text.layout.carets, p))
      return
    }
    dragGesture(gesture, p, e, { selection, snap, r, setGesture, setGuides, onDocChange })
  }

  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!gesture) return
    e.stopPropagation()
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
        // The live preview already holds the final document; committing it
        // makes the whole gesture one undo step. A plain click (nothing
        // dragged) left `base` as it was: committing it would push an empty
        // undo step and clear redo.
        if (doc !== gesture.base) onDocCommit(doc)
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
    // Always ours: the ZoomSurface below would otherwise reset the zoom.
    e.stopPropagation()
    const p = toDoc(e)

    // In the open text a double-click selects the word under it.
    if (text.edit && text.layout) {
      const open = findItem(doc.items, text.edit.id)
      if (open && isText(open)) {
        const [a, b] = wordAt(plainText(open.text), caretIndexAt(text.layout.carets, p))
        text.setRange(a, b)
      }
      return
    }

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
      // Off every node and curve: another shape switches to it, empty space
      // ends node editing — the double-click that got you in gets you out.
      const other = pickItem(doc.items, p, r(ITEM_TOL_PX * HIT), { groupsAreAtomic: false })
      if (other) onEditNodes(other.leafId, p)
      else onExitNodes()
      return
    }

    if (tool !== 'select') return

    // Select tool: double-click a group to enter it (its children become
    // selectable); double-click a shape to edit its nodes. Inside a group the
    // first double-click already lands on the shape, so it goes straight in.
    const hit = pickItem(doc.items, p, r(ITEM_TOL_PX * HIT), { groupsAreAtomic: enteredGroupId === null })
    if (!hit) {
      onEnterGroup(null)
      return
    }
    const target = resolveTarget(doc, hit, enteredGroupId)
    if (target !== hit.leafId) {
      onEnterGroup(target)
      onSelectionChange(new Set([hit.leafId]))
      return
    }
    onEditNodes(hit.leafId, p)
  }

  return { gesture, guides, hoverId, hoverGrip, hoverText, onPointerDown, onPointerMove, onPointerUp, onDoubleClick }
}
