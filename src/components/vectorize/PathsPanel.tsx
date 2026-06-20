// Right rail of the vectorize studio: one row per document item, in paint
// order (first = bottom). Paths get a recolor swatch, visibility toggle and
// delete; raw passthrough markup (defs, gradients…) gets visibility only.

import type { CSSProperties } from 'react'
import { useEffect, useRef } from 'react'
import { Blend, Eye, EyeOff, Square, Trash2, X } from 'lucide-react'
import type { EditableDoc, PathItem, RawItem } from '../../lib/path/types'
import { normalizeHex } from '../../lib/colorUtils'
import { Tooltip } from '../ui/Tooltip'

/** Swatch background: a CSS preview of the gradient when present (and not flattened),
 *  else the flat fill. */
function swatchStyle(item: PathItem): CSSProperties {
  const g = item.gradient
  if (!g || item.gradientHidden) return { backgroundColor: item.fill }
  const stops = g.stops.map((s) => `${s.color} ${Math.round(s.offset * 100)}%`).join(', ')
  if (g.type === 'linear') {
    const angle = Math.round((Math.atan2(g.y2 - g.y1, g.x2 - g.x1) * 180) / Math.PI + 90)
    return { backgroundImage: `linear-gradient(${angle}deg, ${stops})` }
  }
  return { backgroundImage: `radial-gradient(circle, ${stops})` }
}

export interface PathsPanelProps {
  doc: EditableDoc
  selectedPathId: string | null
  onSelectPath: (id: string | null) => void
  /** Recolor a path; `commit` pushes a history entry (live preview otherwise). */
  onRecolor: (id: string, fill: string, commit: boolean) => void
  onToggleVisible: (id: string) => void
  /** Flatten a region's fitted gradient to its solid fill (and back) — reversible. */
  onToggleGradientFlat: (id: string) => void
  onDelete: (id: string) => void
}

/** Desktop right rail — the 260px column. Below md it's hidden; the same body
 *  renders inside the studio's "Paths" bottom sheet instead. */
export function PathsPanel(props: PathsPanelProps) {
  return (
    <aside className="hidden w-[260px] shrink-0 flex-col border-l border-line bg-surface md:flex">
      <PathsPanelBody {...props} />
    </aside>
  )
}

export function PathsPanelBody({
  doc,
  selectedPathId,
  onSelectPath,
  onRecolor,
  onToggleVisible,
  onToggleGradientFlat,
  onDelete,
}: PathsPanelProps) {
  const rowRefs = useRef(new Map<string, HTMLDivElement>())

  // Keep the canvas and list selections visually in sync.
  useEffect(() => {
    if (selectedPathId) {
      rowRefs.current.get(selectedPathId)?.scrollIntoView({ block: 'nearest' })
    }
  }, [selectedPathId])

  let pathCount = 0
  let nodeCount = 0
  for (const item of doc.items) {
    if (item.kind !== 'path') continue
    pathCount++
    for (const sp of item.subPaths) nodeCount += sp.nodes.length
  }

  let pathIndex = 0
  return (
    <>
      <header className="flex items-center gap-2 border-b border-line px-4 py-3">
        <h2 className="text-sm font-semibold text-ink">Paths</h2>
        <span className="rounded-full bg-surface-3 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-ink-2">
          {pathCount}
        </span>
        <span className="ml-auto text-xs text-muted">{nodeCount} nodes</span>
      </header>

      <div className="flex flex-1 flex-col gap-0.5 overflow-y-auto p-2">
        {doc.items.map((item) =>
          item.kind === 'path' ? (
            <PathRow
              key={item.id}
              item={item}
              index={++pathIndex}
              selected={item.id === selectedPathId}
              rowRef={(el) => {
                if (el) rowRefs.current.set(item.id, el)
                else rowRefs.current.delete(item.id)
              }}
              onSelect={() => onSelectPath(item.id === selectedPathId ? null : item.id)}
              onRecolor={(fill, commit) => onRecolor(item.id, fill, commit)}
              onToggleVisible={() => onToggleVisible(item.id)}
              onToggleGradientFlat={() => onToggleGradientFlat(item.id)}
              onDelete={() => onDelete(item.id)}
            />
          ) : (
            <RawRow key={item.id} item={item} onToggleVisible={() => onToggleVisible(item.id)} />
          ),
        )}

        {selectedPathId && (
          <button
            type="button"
            onClick={() => onSelectPath(null)}
            className="mt-1 flex items-center justify-center gap-1.5 rounded-md border border-line px-2 py-1.5 text-xs text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink"
          >
            <X size={13} />
            Clear selection
          </button>
        )}
      </div>
    </>
  )
}

/* ------------------------------------------------------------------- rows */

// Rows are divs (not <button>s): they nest the swatch's color input and the
// eye/trash buttons, which invalid-HTML button nesting would break.
function PathRow({
  item,
  index,
  selected,
  rowRef,
  onSelect,
  onRecolor,
  onToggleVisible,
  onToggleGradientFlat,
  onDelete,
}: {
  item: PathItem
  index: number
  selected: boolean
  rowRef: (el: HTMLDivElement | null) => void
  onSelect: () => void
  onRecolor: (fill: string, commit: boolean) => void
  onToggleVisible: () => void
  onToggleGradientFlat: () => void
  onDelete: () => void
}) {
  let nodes = 0
  for (const sp of item.subPaths) nodes += sp.nodes.length

  return (
    <div
      ref={rowRef}
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect()
        }
      }}
      className={`flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 transition-colors ${
        selected ? 'bg-accent-soft' : 'hover:bg-surface-3'
      }`}
    >
      <Tooltip label={item.gradient ? 'Recolor (replaces gradient with a solid)' : 'Recolor'}>
        <label
          onClick={(e) => e.stopPropagation()}
          className="relative h-[18px] w-[18px] shrink-0 cursor-pointer overflow-hidden rounded border border-line"
          style={swatchStyle(item)}
        >
          <input
            type="color"
            value={normalizeHex(item.fill) ?? '#000000'}
            onChange={(e) => onRecolor(e.target.value, false)}
            onBlur={(e) => onRecolor(e.target.value, true)}
            className="absolute inset-0 cursor-pointer opacity-0"
            aria-label={`Path ${index} fill color`}
          />
        </label>
      </Tooltip>

      <span className={`truncate text-xs ${item.visible ? 'text-ink' : 'text-faint'}`}>
        Path {index}
      </span>
      <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums text-muted">{nodes}</span>

      {item.gradient && (
        <RowIconBtn
          title={item.gradientHidden ? 'Gradient flattened — click to restore' : 'Flatten to solid colour'}
          onClick={onToggleGradientFlat}
        >
          {item.gradientHidden ? <Square size={13} /> : <Blend size={13} />}
        </RowIconBtn>
      )}
      <RowIconBtn
        title={item.visible ? 'Hide (excluded from export)' : 'Show'}
        onClick={onToggleVisible}
      >
        {item.visible ? <Eye size={13} /> : <EyeOff size={13} />}
      </RowIconBtn>
      <RowIconBtn title="Delete path" onClick={onDelete}>
        <Trash2 size={13} />
      </RowIconBtn>
    </div>
  )
}

function RawRow({ item, onToggleVisible }: { item: RawItem; onToggleVisible: () => void }) {
  const label = item.markup.startsWith('<defs')
    ? '<defs>'
    : item.markup.startsWith('<style')
      ? '<style>'
      : 'raw markup'
  return (
    <div className="flex items-center gap-2 rounded-md px-2 py-1.5">
      <span className="h-[18px] w-[18px] shrink-0 rounded border border-dashed border-line-strong" />
      <span className={`truncate font-mono text-[11px] ${item.visible ? 'text-muted' : 'text-faint'}`}>
        {label}
      </span>
      <span className="ml-auto" />
      <RowIconBtn
        title={item.visible ? 'Hide (excluded from export)' : 'Show'}
        onClick={onToggleVisible}
      >
        {item.visible ? <Eye size={13} /> : <EyeOff size={13} />}
      </RowIconBtn>
    </div>
  )
}

function RowIconBtn({
  title,
  onClick,
  children,
}: {
  title: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <Tooltip label={title}>
      <button
        type="button"
        aria-label={title}
        onClick={(e) => {
          e.stopPropagation()
          onClick()
        }}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted transition-colors hover:bg-surface-3 hover:text-ink"
      >
        {children}
      </button>
    </Tooltip>
  )
}
