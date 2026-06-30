// Right rail of the vectorize studio: one row per document item, in paint
// order (first = bottom). Paths get a recolor swatch, visibility toggle and
// delete; raw passthrough markup (defs, gradients…) gets visibility only.

import type { CSSProperties } from 'react'
import { useEffect, useRef } from 'react'
import { Eye, EyeOff, Trash2, X } from 'lucide-react'
import type { EditableDoc, PathItem, RawItem } from '../../lib/path/types'
import { normalizeHex } from '../../lib/colorUtils'
import { Tooltip } from '../ui/Tooltip'
import { PaletteEditor } from './PaletteEditor'

type RGB = { r: number; g: number; b: number; a?: number }

/** Swatch background: a CSS preview of the gradient when present, else the flat fill. */
function swatchStyle(item: PathItem): CSSProperties {
  const g = item.gradient
  if (!g) return { backgroundColor: item.fill }
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
  onDelete: (id: string) => void
  /** Flat-palette editor (color mode + gradients off): the dominant colours the art
   *  reduces to, pinned below the list and always visible. Hidden for gradient art. */
  showPalette?: boolean
  /** Auto-extracted palette (distinct solid fills + alpha) seeding the editor. */
  autoPalette?: RGB[]
  /** User-locked palette (opts.palette) or null when automatic. */
  lockedPalette?: RGB[] | null
  /** Patch opts.palette: an array locks it; null reverts to automatic. */
  onPaletteChange?: (palette: RGB[] | null) => void
  /** Hovering a path row / palette swatch passes its fill so the canvas lights up
   *  every region of that colour; null on leave. */
  onHighlight?: (fill: string | null) => void
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
  onDelete,
  showPalette = false,
  autoPalette,
  lockedPalette,
  onPaletteChange,
  onHighlight,
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
              onDelete={() => onDelete(item.id)}
              onHighlight={onHighlight}
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

      {showPalette && onPaletteChange && (
        // Cap on the SECTION (its parent — the rail — has a definite height, so the
        // percentage resolves); the body scrolls within it. shrink-0 so it isn't
        // crushed by the path list, max-h so it can't crush the list either.
        <div className="flex max-h-[55%] shrink-0 flex-col border-t border-line">
          <h3 className="shrink-0 px-4 pb-1 pt-2.5 text-xs font-semibold text-ink">Palette</h3>
          <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 pb-3">
            <PaletteEditor
              autoPalette={autoPalette ?? []}
              locked={lockedPalette ?? null}
              onChange={onPaletteChange}
              onHighlight={onHighlight}
            />
          </div>
        </div>
      )}
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
  onDelete,
  onHighlight,
}: {
  item: PathItem
  index: number
  selected: boolean
  rowRef: (el: HTMLDivElement | null) => void
  onSelect: () => void
  onRecolor: (fill: string, commit: boolean) => void
  onToggleVisible: () => void
  onDelete: () => void
  onHighlight?: (fill: string | null) => void
}) {
  let nodes = 0
  for (const sp of item.subPaths) nodes += sp.nodes.length

  return (
    <div
      ref={rowRef}
      role="button"
      tabIndex={0}
      onClick={onSelect}
      // Hovering the row locates its region(s) on the canvas (and clears on leave).
      onPointerEnter={() => onHighlight?.(item.fill)}
      onPointerLeave={() => onHighlight?.(null)}
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
      {/* Translucent flat fills (fill-opacity < 1) show their colour over a checker
          so the opacity is visible; opaque fills / gradients keep the solid swatch. */}
      {(() => {
        const translucent = !item.gradient && item.fillOpacity !== undefined && item.fillOpacity < 1
        return (
          <Tooltip
            label={
              item.gradient
                ? 'Recolor (replaces gradient with a solid)'
                : translucent
                  ? `Recolor · ${Math.round((item.fillOpacity ?? 1) * 100)}% opacity`
                  : 'Recolor'
            }
          >
            <label
              onClick={(e) => e.stopPropagation()}
              className={`relative h-[18px] w-[18px] shrink-0 cursor-pointer overflow-hidden rounded border border-line ${translucent ? 'checkerboard' : ''}`}
              style={translucent ? undefined : swatchStyle(item)}
            >
              {translucent && (
                <span className="absolute inset-0" style={{ backgroundColor: item.fill, opacity: item.fillOpacity }} />
              )}
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
        )
      })()}

      <span className={`truncate text-xs ${item.visible ? 'text-ink' : 'text-faint'}`}>
        Path {index}
      </span>
      <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums text-muted">{nodes}</span>

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
