// The layers rail: the document tree, top of the list = top of the stack.
//
// The list is REVERSED against `doc.items`, because paint order runs bottom-up
// and every layers panel ever made runs top-down. Getting that backwards is the
// classic confusion, so the reversal happens once, here, and the rest of the
// editor keeps thinking in paint order.

import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Eye, EyeOff, Folder, Lock, Square, Trash2 } from 'lucide-react'
import type { DocItem, EditableDoc, PathItem } from '../../lib/path/types'
import { isGroup, walkItems } from '../../lib/path/docTree'
import { itemLabel } from './editorDoc'
import { PathView } from '../vector/DocRender'
import { itemBox } from '../../lib/editor/transform'
import { Tooltip } from '../ui/Tooltip'

export interface LayersTreeProps {
  doc: EditableDoc
  selection: ReadonlySet<string>
  onSelect: (id: string, additive: boolean) => void
  onToggleVisible: (id: string) => void
  onToggleExpanded: (id: string) => void
  onRename: (id: string, name: string) => void
  onDelete: (id: string) => void
}

export function LayersTree(props: LayersTreeProps) {
  // Number in PAINT order, not display order. Counting down the reversed list
  // instead would renumber every existing row each time a shape is added — the
  // shape you were looking at silently becomes "Path 4" — and the number would
  // disagree with the one the same shape has everywhere else.
  const numbers = new Map<string, number>()
  let pathIndex = 0
  let groupIndex = 0
  walkItems(props.doc.items, (item) => {
    numbers.set(item.id, isGroup(item) ? ++groupIndex : ++pathIndex)
  })

  const rows: React.ReactNode[] = []
  const render = (items: readonly DocItem[], depth: number) => {
    // Reverse for display: the last painted item is the topmost layer.
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i]
      rows.push(
        <LayerRow
          key={item.id}
          item={item}
          depth={depth}
          index={numbers.get(item.id) ?? 0}
          {...props}
        />,
      )
      if (isGroup(item) && item.expanded !== false) render(item.children, depth + 1)
    }
  }
  render(props.doc.items, 0)

  if (rows.length === 0) {
    return (
      <p className="px-3 py-6 text-center text-xs text-faint">
        Nothing here yet. Draw a shape, or drop an SVG onto the canvas.
      </p>
    )
  }
  return <div className="flex flex-col gap-px py-1">{rows}</div>
}

function LayerRow({
  item,
  depth,
  index,
  selection,
  doc,
  onSelect,
  onToggleVisible,
  onToggleExpanded,
  onRename,
  onDelete,
}: LayersTreeProps & { item: DocItem; depth: number; index: number }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)
  const selected = selection.has(item.id)
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
      onPointerDown={(e) => {
        if (editing) return
        onSelect(item.id, e.shiftKey || e.metaKey || e.ctrlKey)
      }}
      onDoubleClick={() => {
        setDraft(itemLabel(item, index))
        setEditing(true)
      }}
      className={`group flex h-8 shrink-0 cursor-default items-center gap-1.5 rounded-md pr-1 text-xs transition-colors ${
        selected ? 'bg-accent-soft text-accent' : 'text-ink-2 hover:bg-surface-3'
      }`}
      style={{ paddingLeft: 4 + depth * 12 }}
    >
      {group ? (
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
        <span className="min-w-0 flex-1 truncate">{itemLabel(item, index)}</span>
      )}

      <Tooltip label={item.visible ? 'Hide' : 'Show'}>
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
      <Tooltip label="Delete">
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
