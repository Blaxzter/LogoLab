// Pointerdown on an anchor / handle dot: update the node selection and start its drag.

import type { EditableDoc, NodeRef, PathItem, Vec } from '../../../lib/path/types'
import { setNodeKind } from '../../../lib/path/geometry'
import { regionProvenance } from '../../../lib/path/topology'
import { setEdgeNodeKind } from '../../../lib/path/topologyEdit'
import { type DragState, parseNodeKey, withItem } from './geometry'

export interface GrabContext {
  doc: EditableDoc
  selectedItem: PathItem
  selectedNodes: ReadonlySet<string>
  toVb: (clientX: number, clientY: number) => Vec | null
  onSelectNodes: (keys: Set<string>) => void
  onDocChange: (doc: EditableDoc) => void
  beginDrag: (e: React.PointerEvent, drag: DragState) => void
}

/** `key` is a nodeOverlay grab key: 'sub:idx' (anchor) or 'sub:idx:in|out' (handle). */
export function startGrab(e: React.PointerEvent<SVGSVGElement>, key: string, ctx: GrabContext): void {
  const { doc, selectedItem, selectedNodes, toVb, onSelectNodes, onDocChange, beginDrag } = ctx
  const isHandle = key.split(':').length === 3
  const nodeKey = isHandle ? null : key
  const handleKey = isHandle ? key : null
  e.stopPropagation()
  const pt = toVb(e.clientX, e.clientY)
  if (!pt) return
  const startClient = { x: e.clientX, y: e.clientY }
  // Planar region: provenance bridges a materialized NodeRef back to the
  // shared-edge graph so the neighbour region follows. null ⇒ per-item.
  const topoProv = selectedItem.loops ? (regionProvenance(doc, selectedItem) ?? undefined) : undefined

  if (nodeKey) {
    let next: Set<string>
    if (e.shiftKey) {
      next = new Set(selectedNodes)
      if (next.has(nodeKey)) next.delete(nodeKey)
      else next.add(nodeKey)
    } else if (!selectedNodes.has(nodeKey)) {
      next = new Set([nodeKey])
    } else {
      next = new Set(selectedNodes)
    }
    onSelectNodes(next)
    if (next.size === 0) return
    beginDrag(e, {
      type: 'nodes',
      origDoc: doc,
      preDoc: doc,
      origItem: selectedItem,
      refs: [...next].map(parseNodeKey),
      provenance: topoProv,
      startClient,
      startVb: pt,
      moved: false,
      lastDoc: null,
      pointerId: e.pointerId,
    })
    return
  }

  const [subS, idxS, which] = handleKey!.split(':')
  const ref: NodeRef = { sub: Number(subS), idx: Number(idxS) }
  const node = selectedItem.subPaths[ref.sub]?.nodes[ref.idx]
  if (!node) return
  const whichSide: 'in' | 'out' = which === 'in' ? 'in' : 'out'
  // For a planar item, resolve the canonical edge handle this materialized
  // handle maps to (in/out swap under a reversed traversal is baked in).
  const pv = topoProv?.[ref.sub]?.[ref.idx]
  const handleSite = pv ? (whichSide === 'in' ? pv.inHandle : pv.outHandle) : null
  if (selectedItem.loops && !handleSite) return // planar handle with no graph site
  // Alt breaks symmetry: the node becomes a corner before the (unmirrored)
  // handle drag, so smooth-mirroring stops following this handle.
  let baseDoc = doc
  let baseItem = selectedItem
  if (e.altKey && node.kind !== 'corner') {
    if (handleSite) {
      // Corner the edge node this handle belongs to (at a junction the
      // out-handle lives on a different edge than the anchor owner).
      baseDoc = setEdgeNodeKind(doc, handleSite.edgeId, handleSite.edgeNodeIdx, 'corner')
      onDocChange(baseDoc)
    } else {
      baseItem = setNodeKind(selectedItem, ref, 'corner')
      baseDoc = withItem(doc, baseItem)
      onDocChange(baseDoc)
    }
  }
  beginDrag(e, {
    type: 'handle',
    origDoc: baseDoc,
    preDoc: doc,
    origItem: baseItem,
    handleRef: ref,
    which: whichSide,
    handleSite: handleSite ?? undefined,
    mirror: !e.altKey,
    startClient,
    startVb: pt,
    moved: false,
    lastDoc: null,
    pointerId: e.pointerId,
  })
}
