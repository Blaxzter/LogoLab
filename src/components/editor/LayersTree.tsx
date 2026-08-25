// The layers rail: the document tree, top of the list = top of the stack.
//
// The row model (order, indent, what shift-click spans, where a drop lands)
// lives in `lib/editor/layerRows.ts`; this file is the pointer and the paint.
// Reordering is a DRAG on the grip at the left of a row — deliberately not the
// whole row, which has to stay a plain click target for selection and a double
// click target for renaming.

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  Folder,
  GripVertical,
  Lock,
  Square,
  Trash2,
} from 'lucide-react'
import type { DocItem, EditableDoc, PathItem } from '../../lib/path/types'
import { isGroup } from '../../lib/path/docTree'
import {
  dropSpot,
  edgeAt,
  layerRows,
  rowsBetween,
  type DropEdge,
  type DropSpot,
} from '../../lib/editor/layerRows'
import { itemLabel } from './editorDoc'
import { PathView } from '../vector/DocRender'
import { itemBox } from '../../lib/editor/transform'
import { TipLabel, Tooltip } from '../ui/Tooltip'

export interface LayersTreeProps {
  doc: EditableDoc
  selection: ReadonlySet<string>
  /** The whole next selection — the rail resolves plain / toggle / range itself. */
  onSelect: (ids: ReadonlySet<string>) => void
  onToggleVisible: (id: string) => void
  onToggleExpanded: (id: string) => void
  onRename: (id: string, name: string) => void
  onDelete: (id: string) => void
  /** Drop `ids` at a paint-order insertion point. */
  onMove: (ids: ReadonlySet<string>, to: DropSpot) => void
}

interface DragState {
  ids: ReadonlySet<string>
  over: { rowId: string; edge: DropEdge } | null
}

/** How close to the rail's edge a drag has to get before the list scrolls. */
const EDGE_PX = 28
const EDGE_SPEED = 9

export const LayersTree = memo(function LayersTree(props: LayersTreeProps) {
  const rows = useMemo(() => layerRows(props.doc.items), [props.doc.items])
  const rowsRef = useRef(rows)
  rowsRef.current = rows

  const [drag, setDrag] = useState<DragState | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const anchorRef = useRef<string | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const scrollerRef = useRef<HTMLElement | null>(null)
  const stopRef = useRef<(() => void) | null>(null)
  const velRef = useRef(0)
  const dragging = drag !== null

  // The live props, for handlers that outlive the render that made them.
  const propsRef = useRef(props)
  propsRef.current = props

  const setDragState = (next: DragState | null) => {
    dragRef.current = next
    setDrag(next)
  }

  useEffect(() => () => stopRef.current?.(), [])

  /* ----------------------------------------------------------- selection */

  // Every handler a row is handed is IDENTITY-STABLE (it reads `propsRef`, not
  // this render's props) so that `LayerRowView` can be memoized. Without that
  // the rail re-rendered every row on every document change, and each row's
  // thumbnail re-measures the tight bounds of its path — which is most of what
  // made scrubbing a colour crawl on a real traced document.
  const clickRow = useCallback((id: string, e: React.PointerEvent) => {
    const p = propsRef.current
    if (e.shiftKey && anchorRef.current) {
      // The anchor deliberately SURVIVES a range click, so shift-clicking
      // further down keeps re-spanning from the same origin instead of
      // ratcheting the selection open one row at a time.
      p.onSelect(new Set(rowsBetween(rowsRef.current, anchorRef.current, id)))
      return
    }
    anchorRef.current = id
    if (e.metaKey || e.ctrlKey) {
      const next = new Set(p.selection)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      p.onSelect(next)
      return
    }
    p.onSelect(new Set([id]))
  }, [])

  const toggleVisible = useCallback((id: string) => propsRef.current.onToggleVisible(id), [])
  const toggleExpanded = useCallback((id: string) => propsRef.current.onToggleExpanded(id), [])
  const rename = useCallback((id: string, name: string) => propsRef.current.onRename(id, name), [])
  const remove = useCallback((id: string) => propsRef.current.onDelete(id), [])

  /* ---------------------------------------------------------------- drag */

  const endDrag = (drop: boolean) => {
    const state = dragRef.current
    velRef.current = 0
    stopRef.current?.()
    stopRef.current = null
    setDragState(null)
    if (!drop || !state?.over) return
    const to = dropSpot(rowsRef.current, state.over.rowId, state.over.edge)
    if (to) propsRef.current.onMove(state.ids, to)
  }

  const startDrag = useCallback((id: string, e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const selection = propsRef.current.selection
    // Dragging an unselected row drags just it; gripping one of several
    // selected rows takes the whole set along.
    const ids: ReadonlySet<string> = selection.has(id) ? new Set(selection) : new Set([id])
    if (!selection.has(id)) {
      anchorRef.current = id
      propsRef.current.onSelect(ids)
    }
    scrollerRef.current = scrollParent(rootRef.current)
    setDragState({ ids, over: null })

    const onMove = (ev: PointerEvent) => {
      const state = dragRef.current
      if (!state) return
      const el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null
      const rowEl = el?.closest<HTMLElement>('[data-layer-row]')
      const rowId = rowEl?.dataset.layerRow
      if (rowEl && rowId) {
        const box = rowEl.getBoundingClientRect()
        const row = rowsRef.current.find((r) => r.item.id === rowId)
        const edge = edgeAt(ev.clientY - box.top, box.height, row ? isGroup(row.item) : false)
        if (state.over?.rowId !== rowId || state.over.edge !== edge) {
          setDragState({ ...state, over: { rowId, edge } })
        }
      } else if (state.over) {
        setDragState({ ...state, over: null })
      }

      // Auto-scroll: a list taller than the rail is otherwise undraggable past
      // its own edge — the pointer never reaches the rows it has to travel to.
      const sc = scrollerRef.current
      if (!sc) return
      const b = sc.getBoundingClientRect()
      velRef.current =
        ev.clientY < b.top + EDGE_PX
          ? -EDGE_SPEED
          : ev.clientY > b.bottom - EDGE_PX
            ? EDGE_SPEED
            : 0
    }
    const onUp = () => endDrag(true)
    const onCancel = () => endDrag(false)
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return
      ev.stopPropagation()
      endDrag(false)
    }

    // Bound HERE rather than from an effect on `dragging`: an effect only runs
    // after React re-renders, and a fast drag can already be several
    // pointermoves along by then — the first one is what picks the drop row.
    let raf = requestAnimationFrame(function tick() {
      if (velRef.current !== 0) scrollerRef.current?.scrollBy(0, velRef.current)
      raf = requestAnimationFrame(tick)
    })
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    window.addEventListener('keydown', onKey, true)
    stopRef.current = () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [])

  /* -------------------------------------------------------------- render */

  if (rows.length === 0) {
    return (
      <p className="px-3 py-6 text-center text-xs text-faint">
        Nothing here yet. Draw a shape, or drop an SVG onto the canvas.
      </p>
    )
  }

  return (
    <div ref={rootRef} className={`flex flex-col gap-px py-1 ${dragging ? 'cursor-grabbing' : ''}`}>
      {rows.map((row) => (
        <LayerRowView
          key={row.item.id}
          item={row.item}
          depth={row.depth}
          number={row.number}
          selected={props.selection.has(row.item.id)}
          dragging={drag?.ids.has(row.item.id) ?? false}
          over={drag?.over?.rowId === row.item.id ? drag.over.edge : null}
          onPick={clickRow}
          onGrip={startDrag}
          onToggleVisible={toggleVisible}
          onToggleExpanded={toggleExpanded}
          onRename={rename}
          onDelete={remove}
        />
      ))}
    </div>
  )
})

/**
 * One row. Memoized on FLAT props rather than on the `LayerRow` object:
 * `layerRows` mints fresh row objects whenever the document changes, so a
 * row-shaped prop would defeat the memo on exactly the edits it exists to
 * survive — recolouring one shape must not re-render the other two hundred.
 */
const LayerRowView = memo(function LayerRowView({
  item,
  depth,
  number,
  selected,
  dragging,
  over,
  onPick,
  onGrip,
  onToggleVisible,
  onToggleExpanded,
  onRename,
  onDelete,
}: {
  item: DocItem
  depth: number
  number: number
  selected: boolean
  dragging: boolean
  over: DropEdge | null
  onPick: (id: string, e: React.PointerEvent) => void
  onGrip: (id: string, e: React.PointerEvent) => void
  onToggleVisible: (id: string) => void
  onToggleExpanded: (id: string) => void
  onRename: (id: string, name: string) => void
  onDelete: (id: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)
  const group = isGroup(item)

  useEffect(() => {
    if (editing) inputRef.current?.select()
  }, [editing])

  const commitName = () => {
    setEditing(false)
    onRename(item.id, draft)
  }

  return (
    <div
      data-layer-row={item.id}
      onPointerDown={(e) => {
        if (editing) return
        onPick(item.id, e)
      }}
      onDoubleClick={() => {
        setDraft(itemLabel(item, number))
        setEditing(true)
      }}
      className={`group relative flex h-8 shrink-0 cursor-default items-center gap-1 rounded-md pr-1 text-xs transition-colors ${
        selected ? 'bg-accent-soft text-accent' : 'text-ink-2 hover:bg-surface-3'
      } ${dragging ? 'opacity-40' : ''} ${over === 'into' ? 'ring-1 ring-accent' : ''}`}
      style={{ paddingLeft: depth * 12 }}
    >
      {over === 'above' && <DropLine side="top" depth={depth} />}
      {over === 'below' && <DropLine side="bottom" depth={depth} />}

      <Tooltip label={<TipLabel title="Drag to reorder" detail="Drop between rows to restack, or onto a group to move it inside." />}>
        <button
          type="button"
          aria-label="Reorder layer"
          onPointerDown={(e) => onGrip(item.id, e)}
          className="flex h-6 w-3.5 shrink-0 cursor-grab items-center justify-center text-faint opacity-0 hover:text-ink group-hover:opacity-100"
        >
          <GripVertical size={12} />
        </button>
      </Tooltip>

      {group ? (
        <Tooltip
          label={
            <TipLabel
              title={item.expanded === false ? 'Expand group' : 'Collapse group'}
              detail="Only changes what this list shows — the artwork is untouched."
            />
          }
        >
        <button
          type="button"
          onPointerDown={(e) => {
            e.stopPropagation()
            onToggleExpanded(item.id)
          }}
          className="flex h-4 w-4 shrink-0 items-center justify-center text-faint hover:text-ink"
          aria-label={item.expanded === false ? 'Expand group' : 'Collapse group'}
        >
          {item.expanded === false ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        </button>
        </Tooltip>
      ) : (
        <span className="w-4 shrink-0" />
      )}

      <span className="flex h-5 w-5 shrink-0 items-center justify-center">
        {group ? (
          <Folder size={13} className="text-faint" />
        ) : item.kind === 'path' ? (
          <LayerThumb item={item} />
        ) : (
          <Lock size={12} className="text-faint" />
        )}
      </span>

      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitName()
            if (e.key === 'Escape') setEditing(false)
            e.stopPropagation()
          }}
          className="min-w-0 flex-1 rounded border border-line bg-surface px-1 py-0.5 text-xs text-ink outline-none"
        />
      ) : (
        <span className="min-w-0 flex-1 truncate">{itemLabel(item, number)}</span>
      )}

      <Tooltip label={<TipLabel title={item.visible ? 'Hide layer' : 'Show layer'} detail="Hidden layers stay in the file but are left out of the export." />}>
        <button
          type="button"
          onPointerDown={(e) => {
            e.stopPropagation()
            onToggleVisible(item.id)
          }}
          className={`flex h-6 w-6 shrink-0 items-center justify-center rounded text-faint hover:text-ink ${
            item.visible ? 'opacity-0 group-hover:opacity-100' : 'opacity-100'
          }`}
        >
          {item.visible ? <Eye size={13} /> : <EyeOff size={13} />}
        </button>
      </Tooltip>
      <Tooltip label={<TipLabel title="Delete layer" detail="Removes it from the drawing. Ctrl+Z brings it back." />}>
        <button
          type="button"
          onPointerDown={(e) => {
            e.stopPropagation()
            onDelete(item.id)
          }}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-faint opacity-0 hover:text-bad group-hover:opacity-100"
        >
          <Trash2 size={13} />
        </button>
      </Tooltip>
    </div>
  )
})

/** The 2px rule that says where the drop lands, indented to the target depth. */
function DropLine({ side, depth }: { side: 'top' | 'bottom'; depth: number }) {
  return (
    <span
      aria-hidden
      className={`pointer-events-none absolute right-1 h-0.5 rounded-full bg-accent ${
        side === 'top' ? '-top-px' : '-bottom-px'
      }`}
      style={{ left: depth * 12 + 4 }}
    />
  )
}

/** The nearest scrollable ancestor — what a drag near the edge has to nudge. */
function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let node = el?.parentElement ?? null; node; node = node.parentElement) {
    const oy = getComputedStyle(node).overflowY
    if ((oy === 'auto' || oy === 'scroll') && node.scrollHeight > node.clientHeight) return node
  }
  return null
}

/**
 * A 16px thumbnail of the path's own geometry. Cheap — the path data is already
 * cached — and far more useful than a colour chip when a document has a dozen
 * shapes that happen to share a fill.
 */
function LayerThumb({ item }: { item: PathItem }) {
  const box = itemBox(item)
  if (!box || box.w === 0 || box.h === 0) {
    return <Square size={12} style={{ color: item.fill }} />
  }
  // `itemBox` is the GEOMETRY box, which for a stroked path stops at the
  // centreline — so half the stroke sits outside it and a thumbnail cropped to
  // it clips a 40-unit outline down to a sliver. Pad by half the width.
  const pad = Math.max(box.w, box.h) * 0.06 + (item.stroke?.width ?? 0) / 2
  return (
    // Checkerboard rather than a white plate: white artwork is extremely common
    // (knocked-out marks, light-on-dark logos) and white-on-white makes the
    // thumbnail look empty — which reads as "this layer is broken".
    <svg
      width={16}
      height={16}
      viewBox={`${box.x - pad} ${box.y - pad} ${box.w + pad * 2} ${box.h + pad * 2}`}
      className="checkerboard rounded-[3px] ring-1 ring-line"
      aria-hidden
    >
      {/* The SHARED renderer, so a thumbnail can never disagree with the canvas
          about how a path paints — gradients included. Its own gradient-id
          scope keeps those defs from colliding with the canvas's. */}
      <PathView item={item} scope={`thumb-${item.id}`} />
    </svg>
  )
}
