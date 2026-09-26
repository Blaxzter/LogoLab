// Node-editing SVG canvas for the vectorize studio. Renders an EditableDoc
// inside a shared pan/zoom surface and (in node mode) lets the user drag whole
// paths, anchors and Bézier handles, insert nodes on segments, and toggle
// corner/smooth joints.
//
// Coordinate model: the doc's viewBox aspect is fitted into the available
// space as an explicitly-sized "fitted box"; the <svg> fills that box exactly,
// so the svg element rect is the drawing rect and pointer → viewBox mapping is
// a plain proportion off getBoundingClientRect() (the pan/zoom CSS transform
// is already baked into that rect). All gestures compute from a pointerdown
// snapshot with cumulative deltas, so previews never accumulate drift.

import { ZoomSurface } from '../ui/ZoomSurface'
import { useFitBox } from './useFitBox'
import type { PanZoom } from '../../hooks/usePanZoom'
import type { EditableDoc, PathItem, Vec } from '../../lib/path/types'
import { representativePaint } from '../../lib/path/model'
import { HitPath, ItemsView, visiblePaths } from '../vector/DocRender'
import { ACCENT, REMOVE_MARKER } from './editorCanvas/constants'
import { NodeOverlay } from './editorCanvas/NodeOverlay'
import { GhostMarker, HighlightOverlay, MarkerPins } from './editorCanvas/overlays'
import { useCanvasInteraction } from './editorCanvas/useCanvasInteraction'

export interface EditorCanvasProps {
  doc: EditableDoc
  pz: PanZoom
  tool: 'pan' | 'node' | 'mark'
  /** False while tracing — render only, no editing. */
  editable: boolean
  selectedPathId: string | null
  /** Selected node keys, 'sub:idx'. */
  selectedNodes: ReadonlySet<string>
  /** Original-image ghost rendered under the SVG (overlay view mode). */
  underlay?: { src: string; opacity: number } | null
  /** Region markers (segmentation seeds) in normalized [0,1] image coords. */
  markers?: { x: number; y: number; flat?: boolean; remove?: boolean }[]
  /** Which marker kind the mark tool drops — tints the hover-highlight to match. */
  markMode?: 'separate' | 'flat' | 'remove'
  /** Pre-merge region map (fine regions before the field-merge) from the last
   *  trace; the mark tool highlights the region under the cursor from it. */
  preMerge?: { labels: Int32Array; width: number; height: number } | null
  /** Hovering a palette swatch / path row sets this fill; every visible path with
   *  it lights up. null ⇒ none. */
  highlightFill?: string | null
  onSelectPath: (id: string | null) => void
  onSelectNodes: (keys: Set<string>) => void
  /** Records the in-region click point that selected a path — the seed for a
   *  "remove & heal" delete (which blob of a multi-blob region to dissolve). */
  onRegionSeed?: (id: string, pt: Vec) => void
  /** Live preview during drags (no history commit). */
  onDocChange: (doc: EditableDoc) => void
  /** History-committing final state (pointerup, double-click edits). */
  onDocCommit: (doc: EditableDoc) => void
  /** Add a marker at normalized [0,1] coords (mark tool). */
  onAddMarker?: (x: number, y: number) => void
  /** Remove the marker at the given index (mark tool). */
  onRemoveMarker?: (index: number) => void
  /** Forwarded to ZoomSurface — registers the box the +/- buttons zoom around. */
  primary?: boolean
}

export function EditorCanvas({
  doc,
  pz,
  tool,
  editable,
  selectedPathId,
  selectedNodes,
  underlay,
  markers,
  markMode = 'separate',
  preMerge,
  highlightFill,
  onSelectPath,
  onSelectNodes,
  onRegionSeed,
  onDocChange,
  onDocCommit,
  onAddMarker,
  onRemoveMarker,
  primary = false,
}: EditorCanvasProps) {
  const [vbX, vbY, vbW, vbH] = doc.viewBox
  const fit = useFitBox(vbW, vbH)
  const {
    boxRef,
    svgRef,
    interactive,
    marking,
    selectedItem,
    hoveredKey,
    removeHoverD,
    hoverPt,
    hoverOverlay,
    marqueeRect,
    handlePathPointerDown,
    handleGrabPointerDown,
    handleSvgPointerDown,
    handleSvgPointerMove,
    handleSvgPointerUp,
    handleSvgPointerCancel,
    handleSvgPointerLeave,
    handleSvgDoubleClick,
  } = useCanvasInteraction({
    doc,
    tool,
    editable,
    selectedPathId,
    selectedNodes,
    markers,
    markMode,
    preMerge,
    onSelectPath,
    onSelectNodes,
    onRegionSeed,
    onDocChange,
    onDocCommit,
    onAddMarker,
    onRemoveMarker,
  })
  // px per viewBox unit at the current zoom (fit.width is the layout size; the
  // pan/zoom transform multiplies it on screen). Guard the pre-measure frame.
  const screenScale = fit.width > 0 ? (fit.width * pz.scale) / vbW : 1

  // Colour-locator highlight: every visible path painted exactly `highlightFill`
  // (set while hovering its palette swatch / path row).
  const highlightItems = highlightFill
    ? (doc.items.filter(
        (it) =>
          it.kind === 'path' &&
          it.visible &&
          // A stroke-only path's colour is its stroke; its fill is "none".
          representativePaint(it) === highlightFill,
      ) as PathItem[])
    : []

  const r = (px: number) => px / screenScale

  return (
    <ZoomSurface pz={pz} primary={primary} className="h-full w-full">
      <div ref={fit.parentRef} className="flex h-full w-full items-center justify-center p-[6%]">
        <div ref={boxRef} className="relative" style={{ width: fit.width, height: fit.height }}>
          {underlay && (
            <img
              src={underlay.src}
              alt=""
              draggable={false}
              className="pointer-events-none absolute inset-0 h-full w-full select-none"
              style={{ opacity: underlay.opacity }}
            />
          )}
          <svg
            ref={svgRef}
            viewBox={`${vbX} ${vbY} ${vbW} ${vbH}`}
            width="100%"
            height="100%"
            // The fitted box already has the viewBox aspect, so "none" never
            // visibly stretches; it keeps the mapping a pure proportion, which
            // is what toVb inverts. "meet" can letterbox by a sub-pixel, which
            // shows as a cursor-to-marker gap at high zoom.
            preserveAspectRatio="none"
            className={
              marking
                ? 'cursor-none'
                : interactive
                  ? hoveredKey
                    ? hoveredKey.split(':').length === 3
                      ? 'cursor-crosshair'
                      : 'cursor-move'
                    : 'cursor-crosshair'
                  : ''
            }
            style={{
              display: 'block',
              touchAction: 'none',
              // Pan mode / render-only: the surface beneath pans & zooms freely.
              // Node + mark modes capture pointer events on the svg.
              pointerEvents: interactive || marking ? undefined : 'none',
            }}
            onPointerDownCapture={handleGrabPointerDown}
            onPointerDown={handleSvgPointerDown}
            onPointerMove={handleSvgPointerMove}
            onPointerUp={handleSvgPointerUp}
            onPointerCancel={handleSvgPointerCancel}
            onPointerLeave={handleSvgPointerLeave}
            onDoubleClick={handleSvgDoubleClick}
          >
            <g onPointerDown={handlePathPointerDown}>
              {/* Paint layer: the shared renderer (components/vector/DocRender). */}
              <ItemsView items={doc.items} interactive={interactive} />
              {/* Interaction layer: fat invisible strokes so a
                                hairline outline is still grabbable. */}
              {interactive &&
                visiblePaths(doc.items).map((item) => <HitPath key={item.id} item={item} width={r(10)} />)}
            </g>

            {/* Colour-locator highlight for the hovered palette colour. */}
            {highlightItems.length > 0 && fit.width > 0 && <HighlightOverlay items={highlightItems} r={r} />}

            {/* Selection overlay, drawn as a few batched paths (see
                            nodeOverlay.ts) because one element per node doesn't scale
                            to large traces. Grabbing is geometric (nearestGrab). */}
            {selectedItem && fit.width > 0 && (
              <NodeOverlay
                item={selectedItem}
                scale={screenScale}
                selectedNodes={selectedNodes}
                hoveredKey={interactive ? hoveredKey : null}
              />
            )}

            {/* Marquee selection rectangle */}
            {marqueeRect && (
              <rect
                x={marqueeRect.x}
                y={marqueeRect.y}
                width={marqueeRect.w}
                height={marqueeRect.h}
                fill="rgba(91, 91, 214, 0.08)"
                stroke={ACCENT}
                strokeWidth={r(1)}
                strokeDasharray={`${r(4)} ${r(2)}`}
                style={{ pointerEvents: 'none' }}
              />
            )}

            {/* Mark tool, flat mode: tint the pre-merge region a flat
                            marker would carve out. Above the paths, below the pins. */}
            {marking && markMode === 'flat' && hoverOverlay && (
              <image
                href={hoverOverlay}
                x={vbX}
                y={vbY}
                width={vbW}
                height={vbH}
                preserveAspectRatio="none"
                opacity={0.4}
                style={{ pointerEvents: 'none' }}
              />
            )}

            {/* Remove mode: the region a click would dissolve. */}
            {marking && markMode === 'remove' && removeHoverD && (
              <path
                d={removeHoverD}
                fill={REMOVE_MARKER}
                fillOpacity={0.32}
                stroke={REMOVE_MARKER}
                strokeWidth={r(1.5)}
                strokeOpacity={0.95}
                style={{ pointerEvents: 'none' }}
              />
            )}

            {/* Region markers, drawn in every tool. Clicks are hit-tested
                            by the svg, so the pins never intercept pointer events. */}
            {markers && markers.length > 0 && fit.width > 0 && (
              <MarkerPins markers={markers} viewBox={doc.viewBox} r={r} />
            )}

            {/* Ghost marker: the pin the next click will drop, at exactly
                            the point a click stores. */}
            {marking && hoverPt && fit.width > 0 && <GhostMarker pt={hoverPt} markMode={markMode} r={r} />}
          </svg>
        </div>
      </div>
    </ZoomSurface>
  )
}
