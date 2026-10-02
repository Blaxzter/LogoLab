// The editor canvas: rendering, hit-testing and every pointer gesture.
//
// Pan vs edit: the stage sits inside a ZoomSurface that pans on drag and zooms
// on the wheel. Each pointerdown decides who owns the gesture, and the stage
// stops propagation only when it takes it; Space, the middle button and the Pan
// tool let the event through to the surface.
//
// Handles, grips and hit radii are specified in screen pixels and converted to
// viewBox units through `upp` (units per screen pixel, including zoom), so they
// stay the same on-screen size at every zoom level.
//
// Drags recompute from a snapshot taken at pointerdown plus the cumulative
// pointer delta, never incrementally from the previous frame, which would
// accumulate drift and make a snapped drag stick to its own snap.

import { useCallback, useMemo, useRef } from 'react'
import type { EditableDoc, PathItem, Vec } from '../../lib/path/types'
import { findItem, isGroup, allPaths } from '../../lib/path/docTree'
import { selectionBox, type Box } from '../../lib/editor/transform'
import { boxFromPoints } from '../../lib/editor/hitTest'
import type { SnapConfig } from '../../lib/editor/snapping'
import { ZoomSurface } from '../ui/ZoomSurface'
import type { PanZoom } from '../../hooks/usePanZoom'
import { useFitBox } from '../vectorize/useFitBox'
import { ItemsView, pathD } from '../vector/DocRender'
import type { EditorTool } from './tools'
import { buildShape as buildShapeFor } from './stage/buildShape'
import { ACCENT, GRIP_CURSOR } from './stage/stageConstants'
import { GridOverlay, NodeOverlay, SelectionOutline, SnapGuides, TransformBox } from './stage/StageOverlays'
import { useSpaceHeld } from './stage/useSpaceHeld'
import { useStageGestures } from './stage/useStageGestures'

// Node keys live in the pure core; re-exported for existing importers.
export { nodeKey, parseNodeKey } from '../../lib/editor/nodeEdit'

export interface EditorStageProps {
  doc: EditableDoc
  pz: PanZoom
  /**
   * A growing artboard's camera view, in document units: the stage then fills
   * its pane and shows this rect, so there is no edge to the board. Null for a
   * fixed artboard (and for one frame while the pane is first measured).
   */
  boardView: Box | null
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
  boardView,
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
  const grow = doc.artboard === 'grow'

  // What the stage shows and takes pointer input over, in document units: the
  // artboard itself, or on the infinite board whatever the camera looks at.
  const board = grow ? boardView : null
  const [fx, fy, fw, fh] = board ? [board.x, board.y, board.w, board.h] : [vx, vy, vw, vh]

  // Snapping to a growing artboard's edges would snap a shape to its own bounds.
  const stageSnap = useMemo(() => (grow ? { ...snap, toArtboard: false } : snap), [grow, snap])

  const { parentRef, width: boxW, height: boxH } = useFitBox(fw, fh)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const spaceHeld = useSpaceHeld()

  /** Document units per screen pixel; sizes all on-canvas chrome. On the board
   *  the fitted box IS the pane (same aspect) and the zoom is in the view. */
  const upp = board ? fw / Math.max(1, boxW) : fw / Math.max(1, boxW * pz.scale)
  const r = useCallback((px: number) => px * upp, [upp])

  /* ------------------------------------------------------ coordinates */

  const toDoc = useCallback(
    (e: { clientX: number; clientY: number }): Vec => {
      const rect = svgRef.current?.getBoundingClientRect()
      if (!rect || rect.width === 0) return { x: 0, y: 0 }
      return {
        x: fx + ((e.clientX - rect.left) / rect.width) * fw,
        y: fy + ((e.clientY - rect.top) / rect.height) * fh,
      }
    },
    [fx, fy, fw, fh],
  )

  /* ----------------------------------------------------- derived state */

  const box = useMemo(() => selectionBox(doc.items, selection), [doc.items, selection])

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

  const isDrawTool = tool === 'rect' || tool === 'ellipse' || tool === 'line' || tool === 'polygon' || tool === 'star'

  /* ------------------------------------------------------- shape build */

  const buildShape = useCallback(
    (a: Vec, b: Vec, shift: boolean): PathItem | null => buildShapeFor(tool, vw, a, b, shift),
    [tool, vw],
  )

  const { gesture, guides, hoverId, hoverGrip, onPointerDown, onPointerMove, onPointerUp, onDoubleClick } =
    useStageGestures({
      doc,
      tool,
      selection,
      nodeSel,
      snap: stageSnap,
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
    })

  /* ---------------------------------------------------------- rendering */

  const marqueeBox = gesture?.kind === 'marquee' ? boxFromPoints(gesture.start, gesture.current) : null
  const drawPreview = gesture?.kind === 'draw' ? buildShape(gesture.start, gesture.current, false) : null

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
            className={`relative ${board ? '' : 'shadow-sm'} ${checkerClass}`}
            style={{ width: boxW || 1, height: boxH || 1, ...(board ? boardChecker(board, upp) : null) }}
          >
            <svg
              ref={svgRef}
              viewBox={`${fx} ${fy} ${fw} ${fh}`}
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
              {/* Catches empty-space clicks; transparent so the checker shows. */}
              <rect x={fx} y={fy} width={fw} height={fh} fill="transparent" />

              {showGrid && gridStep > 0 && (
                <GridOverlay vx={fx} vy={fy} vw={fw} vh={fh} step={gridStep} width={r(0.6)} />
              )}

              <g style={{ pointerEvents: 'none' }}>
                <ItemsView items={doc.items} />
              </g>

              {/* A growing artboard's edge: what the export will crop to. An
                  empty board has none yet — it grows from what is drawn. */}
              {grow && doc.items.length > 0 && (
                <rect
                  x={vx}
                  y={vy}
                  width={vw}
                  height={vh}
                  fill="none"
                  stroke={ACCENT}
                  strokeWidth={r(1)}
                  strokeDasharray={`${r(5)} ${r(4)}`}
                  opacity={0.6}
                  style={{ pointerEvents: 'none' }}
                />
              )}

              <g style={{ pointerEvents: 'none' }}>
                {/* Hover echo, so you know what a click would take. */}
                {hoverId && !selection.has(hoverId) && !gesture && (
                  <SelectionOutline doc={doc} id={hoverId} width={r(1)} color={ACCENT} opacity={0.5} />
                )}

                {[...selection].map((id) => (
                  <SelectionOutline key={id} doc={doc} id={id} width={r(1.25)} color={ACCENT} />
                ))}

                {tool === 'select' && box && !gesture && <TransformBox box={box} r={r} />}
                {tool === 'select' && box && gesture?.kind === 'move' && <TransformBox box={box} r={r} />}

                {tool === 'node' &&
                  nodePaths.map((path) => (
                    <NodeOverlay key={path.id} path={path} nodeSel={nodeSel} r={r} penTip={penPathId === path.id} />
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

                <SnapGuides guides={guides} vx={fx} vy={fy} vw={fw} vh={fh} width={r(1)} />
              </g>
            </svg>
          </div>
        </div>
      </ZoomSurface>
    </div>
  )
}

/**
 * Pin the checker to the DOCUMENT, not the pane, so panning slides the board
 * under the cursor instead of the art over a still backdrop.
 */
function boardChecker(view: Box, upp: number): React.CSSProperties {
  const ox = -view.x / upp
  const oy = -view.y / upp
  return {
    backgroundPosition: `${ox}px ${oy}px, ${ox}px ${oy + 8}px, ${ox + 8}px ${oy - 8}px, ${ox - 8}px ${oy}px`,
  }
}
