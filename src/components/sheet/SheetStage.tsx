// The sheet itself, with the detected crop boxes drawn on it.
//
// This is where you check the split and fix it: click a box to select, drag it or
// its corners to adjust, drag on empty paper (in Draw mode) to add one the
// detector missed. Boxes are stored in SHEET pixels and drawn in percentages, so
// they ride the pan/zoom for free — but their outlines and handles counter-scale
// by `--pz-scale`, or they'd balloon into slabs at 8×.

import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Trash2 } from 'lucide-react'
import { ZoomSurface } from '../ui/ZoomSurface'
import { useFitBox } from '../vectorize/useFitBox'
import type { PanZoom } from '../../hooks/usePanZoom'
import type { Rect } from '../../lib/sheet'
import type { SheetIcon, SheetSource } from '../../sheetStore'

type Corner = 'nw' | 'ne' | 'sw' | 'se'

type Drag =
  | { kind: 'move'; id: string; ox: number; oy: number; orig: Rect; rect: Rect }
  | { kind: 'resize'; id: string; corner: Corner; orig: Rect; rect: Rect }
  | { kind: 'draw'; ax: number; ay: number; rect: Rect }

const MIN_SIZE = 6

export interface SheetStageProps {
  source: SheetSource
  tiles: SheetIcon[]
  selectedId: string | null
  pz: PanZoom
  /** Drag on empty paper draws a new box instead of panning. */
  draw: boolean
  checkerClass: string
  onSelect: (id: string | null) => void
  onRectChange: (id: string, rect: Rect) => void
  onCreate: (rect: Rect) => void
  onDelete: (id: string) => void
  onOpen: (id: string) => void
}

export function SheetStage({
  source,
  tiles,
  selectedId,
  pz,
  draw,
  checkerClass,
  onSelect,
  onRectChange,
  onCreate,
  onDelete,
  onOpen,
}: SheetStageProps) {
  const fit = useFitBox(source.width, source.height)
  const boxRef = useRef<HTMLDivElement | null>(null)
  const [drag, setDrag] = useState<Drag | null>(null)

  /** Client point → sheet pixels. Uses the live rect, so it is zoom-correct. */
  const toSheet = (e: ReactPointerEvent): { x: number; y: number } => {
    const r = boxRef.current?.getBoundingClientRect()
    if (!r || r.width === 0) return { x: 0, y: 0 }
    return {
      x: ((e.clientX - r.left) / r.width) * source.width,
      y: ((e.clientY - r.top) / r.height) * source.height,
    }
  }

  const startMove = (e: ReactPointerEvent, tile: SheetIcon) => {
    e.stopPropagation()
    e.preventDefault()
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    const p = toSheet(e)
    onSelect(tile.id)
    setDrag({ kind: 'move', id: tile.id, ox: p.x - tile.rect.x, oy: p.y - tile.rect.y, orig: tile.rect, rect: tile.rect })
  }

  const startResize = (e: ReactPointerEvent, tile: SheetIcon, corner: Corner) => {
    e.stopPropagation()
    e.preventDefault()
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    setDrag({ kind: 'resize', id: tile.id, corner, orig: tile.rect, rect: tile.rect })
  }

  const startDraw = (e: ReactPointerEvent) => {
    if (e.button !== 0) return
    if (!draw) {
      // A press on bare paper drops the selection (and still pans — the press
      // falls through to ZoomSurface).
      onSelect(null)
      return
    }
    e.stopPropagation()
    e.preventDefault()
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    const p = toSheet(e)
    setDrag({ kind: 'draw', ax: p.x, ay: p.y, rect: { x: p.x, y: p.y, w: 0, h: 0 } })
  }

  const onMove = (e: ReactPointerEvent) => {
    if (!drag) return
    const p = toSheet(e)
    if (drag.kind === 'move') {
      setDrag({ ...drag, rect: { ...drag.orig, x: Math.round(p.x - drag.ox), y: Math.round(p.y - drag.oy) } })
      return
    }
    if (drag.kind === 'resize') {
      const o = drag.orig
      const right = o.x + o.w
      const bottom = o.y + o.h
      const west = drag.corner === 'nw' || drag.corner === 'sw'
      const north = drag.corner === 'nw' || drag.corner === 'ne'
      const x0 = west ? Math.min(p.x, right - MIN_SIZE) : o.x
      const y0 = north ? Math.min(p.y, bottom - MIN_SIZE) : o.y
      const x1 = west ? right : Math.max(p.x, o.x + MIN_SIZE)
      const y1 = north ? bottom : Math.max(p.y, o.y + MIN_SIZE)
      setDrag({ ...drag, rect: { x: Math.round(x0), y: Math.round(y0), w: Math.round(x1 - x0), h: Math.round(y1 - y0) } })
      return
    }
    setDrag({
      ...drag,
      rect: {
        x: Math.round(Math.min(drag.ax, p.x)),
        y: Math.round(Math.min(drag.ay, p.y)),
        w: Math.round(Math.abs(p.x - drag.ax)),
        h: Math.round(Math.abs(p.y - drag.ay)),
      },
    })
  }

  const endDrag = () => {
    if (!drag) return
    if (drag.kind === 'draw') {
      // A click that didn't travel is a deselect, not a 1px box.
      if (drag.rect.w >= MIN_SIZE && drag.rect.h >= MIN_SIZE) onCreate(drag.rect)
    } else if (drag.rect.w >= MIN_SIZE && drag.rect.h >= MIN_SIZE) {
      onRectChange(drag.id, drag.rect)
    }
    setDrag(null)
  }

  const liveRect = (tile: SheetIcon): Rect =>
    drag && drag.kind !== 'draw' && drag.id === tile.id ? drag.rect : tile.rect

  const pct = (rect: Rect) => ({
    left: `${(rect.x / source.width) * 100}%`,
    top: `${(rect.y / source.height) * 100}%`,
    width: `${(rect.w / source.width) * 100}%`,
    height: `${(rect.h / source.height) * 100}%`,
  })

  return (
    <ZoomSurface pz={pz} primary className="h-full w-full">
      <div ref={fit.parentRef} className="flex h-full w-full items-center justify-center p-[4%]">
        <div
          ref={boxRef}
          className={`relative ${checkerClass}`}
          style={{ width: fit.width || undefined, height: fit.height || undefined }}
          onPointerDown={startDraw}
          onPointerMove={onMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <img
            src={source.src}
            alt=""
            draggable={false}
            className="pointer-events-none absolute inset-0 h-full w-full select-none"
          />

          {fit.width > 0 &&
            tiles.map((tile, index) => {
              const selected = tile.id === selectedId
              const rect = liveRect(tile)
              const label = tile.kind === 'label'
              return (
                <div
                  key={tile.id}
                  role="button"
                  tabIndex={-1}
                  aria-label={tile.name}
                  className="absolute"
                  style={{
                    ...pct(rect),
                    // Counter-scale so the outline stays hairline at any zoom.
                    outlineStyle: 'solid',
                    outlineWidth: `calc(${selected ? 2.5 : 1.5}px / var(--pz-scale, 1))`,
                    outlineColor: selected
                      ? 'var(--color-accent)'
                      : label
                        ? 'color-mix(in oklab, var(--color-muted) 70%, transparent)'
                        : 'color-mix(in oklab, var(--color-accent) 55%, transparent)',
                    outlineOffset: 0,
                    background: selected ? 'color-mix(in oklab, var(--color-accent) 10%, transparent)' : 'transparent',
                    cursor: draw ? 'crosshair' : 'move',
                    opacity: !tile.included ? 0.45 : 1,
                    pointerEvents: draw ? 'none' : 'auto',
                  }}
                  onPointerDown={(e) => startMove(e, tile)}
                  onDoubleClick={(e) => {
                    e.stopPropagation()
                    onOpen(tile.id)
                  }}
                >
                  <span
                    className="pointer-events-none absolute left-0 top-0 origin-top-left rounded-br font-mono tabular-nums text-accent-fg"
                    style={{
                      background: selected ? 'var(--color-accent)' : 'color-mix(in oklab, var(--color-accent) 70%, transparent)',
                      fontSize: `calc(10px / var(--pz-scale, 1))`,
                      padding: `calc(1px / var(--pz-scale, 1)) calc(3px / var(--pz-scale, 1))`,
                      lineHeight: 1.4,
                    }}
                  >
                    {index + 1}
                  </span>

                  {selected && (
                    <>
                      {(['nw', 'ne', 'sw', 'se'] as Corner[]).map((corner) => (
                        <span
                          key={corner}
                          onPointerDown={(e) => startResize(e, tile, corner)}
                          className="absolute block rounded-[2px] border border-accent bg-surface"
                          style={{
                            width: `calc(9px / var(--pz-scale, 1))`,
                            height: `calc(9px / var(--pz-scale, 1))`,
                            borderWidth: `calc(1px / var(--pz-scale, 1))`,
                            left: corner === 'nw' || corner === 'sw' ? `calc(-4.5px / var(--pz-scale, 1))` : undefined,
                            right: corner === 'ne' || corner === 'se' ? `calc(-4.5px / var(--pz-scale, 1))` : undefined,
                            top: corner === 'nw' || corner === 'ne' ? `calc(-4.5px / var(--pz-scale, 1))` : undefined,
                            bottom: corner === 'sw' || corner === 'se' ? `calc(-4.5px / var(--pz-scale, 1))` : undefined,
                            cursor: corner === 'nw' || corner === 'se' ? 'nwse-resize' : 'nesw-resize',
                          }}
                        />
                      ))}
                      <button
                        type="button"
                        title="Remove this box"
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation()
                          onDelete(tile.id)
                        }}
                        className="absolute flex items-center justify-center rounded-full bg-bad text-white"
                        style={{
                          width: `calc(16px / var(--pz-scale, 1))`,
                          height: `calc(16px / var(--pz-scale, 1))`,
                          right: `calc(-8px / var(--pz-scale, 1))`,
                          top: `calc(-8px / var(--pz-scale, 1))`,
                        }}
                      >
                        <Trash2 style={{ width: `calc(9px / var(--pz-scale, 1))`, height: `calc(9px / var(--pz-scale, 1))` }} />
                      </button>
                    </>
                  )}
                </div>
              )
            })}

          {drag?.kind === 'draw' && drag.rect.w > 0 && (
            <div
              className="pointer-events-none absolute bg-accent/10"
              style={{
                ...pct(drag.rect),
                outlineStyle: 'dashed',
                outlineWidth: `calc(2px / var(--pz-scale, 1))`,
                outlineColor: 'var(--color-accent)',
              }}
            />
          )}
        </div>
      </div>
    </ZoomSurface>
  )
}
