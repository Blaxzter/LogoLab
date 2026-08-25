// The properties rail: paint, geometry and alignment for the current selection.
//
// Every numeric field is a "commit on blur / Enter, preview never" control. A
// field that applied on each keystroke would push one undo step per digit and
// would fight you the moment you cleared it to retype — so the draft lives in
// local state until you leave the field.
//
// The two CONTINUOUS controls — the colour wells and the sliders — can't work
// that way: they have no commit moment, they just stop. They pass `live` with
// every change instead, and the studio folds the burst into one undo entry.

import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalSpaceAround,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalSpaceAround,
  FlipHorizontal,
  FlipVertical,
} from 'lucide-react'
import type { EditableDoc, PathItem, Stroke } from '../../lib/path/types'
import { allPaths, findItem, isGroup } from '../../lib/path/docTree'
import type { AlignEdge, DistributeAxis } from '../../lib/editor/align'
import type { Box } from '../../lib/editor/transform'
import { TipLabel, Tooltip } from '../ui/Tooltip'
import { ActionButton, isOff } from '../ui/ActionButton'
import { normalizeHex } from '../../lib/colorUtils'
import { docPalette } from './editorDoc'

export interface InspectorProps {
  doc: EditableDoc
  selection: ReadonlySet<string>
  box: Box | null
  /** `live` marks one frame of a scrub, not a finished pick. */
  onFill: (fill: string, live?: boolean) => void
  onFillOpacity: (v: number, live?: boolean) => void
  onFillRule: (rule: 'nonzero' | 'evenodd') => void
  onStroke: (stroke: Stroke | null, live?: boolean) => void
  onGeometry: (patch: { x?: number; y?: number; w?: number; h?: number }) => void
  onAlign: (edge: AlignEdge) => void
  onDistribute: (axis: DistributeAxis) => void
  onFlip: (axis: 'x' | 'y') => void
  canDistribute: boolean
}

export function Inspector({
  doc,
  selection,
  box,
  onFill,
  onFillOpacity,
  onFillRule,
  onStroke,
  onGeometry,
  onAlign,
  onDistribute,
  onFlip,
  canDistribute,
}: InspectorProps) {
  // Representative paint: the first selected path (walking into groups), which
  // is what the swatches show and what editing them uses as the base.
  const paths: PathItem[] = []
  for (const id of selection) {
    const item = findItem(doc.items, id)
    if (!item) continue
    if (isGroup(item)) paths.push(...allPaths(item.children))
    else if (item.kind === 'path') paths.push(item)
  }
  const lead = paths[0] ?? null

  // The document's palette is DEFERRED. Every frame of a colour scrub changes
  // the document, hence the palette, hence all of its swatches — for a strip
  // nobody is reading mid-drag, and which flickers while it re-sorts. Deferred,
  // React renders the swatches at low priority: during a fast scrub the whole
  // strip is simply skipped, and it catches up the moment the drag settles.
  const paletteDoc = useDeferredValue(doc)
  const palette = useMemo(() => docPalette(paletteDoc), [paletteDoc])
  // Stable, so <Palette> can bail out on the frames where `palette` has not
  // moved. `onFill` itself is a fresh closure on every parent render.
  const fillRef = useRef(onFill)
  fillRef.current = onFill
  const pickPaletteColor = useCallback((c: string) => fillRef.current(c), [])

  if (selection.size === 0) {
    return (
      <div className="p-3">
        <p className="text-xs text-faint">
          Nothing selected. Click a shape, drag a marquee, or press{' '}
          <kbd className="rounded border border-line px-1">Ctrl</kbd>+
          <kbd className="rounded border border-line px-1">A</kbd>.
        </p>
        {palette.length > 0 && (
          <div className="mt-4">
            <h4 className="field-label mb-1.5">Document colours</h4>
            <Palette palette={palette} />
          </div>
        )}
      </div>
    )
  }

  // Why a paint control can't be used. `lead` is the first selected PATH, so
  // its absence means the selection is all groups-of-nothing or raw markup.
  const paintReason = lead
    ? null
    : 'Nothing paintable is selected — imported markup keeps the paint it came with and can\u2019t be recoloured here.'
  const spreadReason = canDistribute
    ? null
    : 'Select three or more items. Spacing two of them evenly is the same as aligning them.'

  return (
    <div className="flex flex-col gap-4 p-3">
      <Section title="Arrange">
        <div className="grid grid-cols-6 gap-1">
          <AlignBtn label="Align left" note={ALIGN_REF} onClick={() => onAlign('left')}><AlignStartVertical size={14} /></AlignBtn>
          <AlignBtn label="Centre horizontally" note={ALIGN_REF} onClick={() => onAlign('hcenter')}><AlignCenterVertical size={14} /></AlignBtn>
          <AlignBtn label="Align right" note={ALIGN_REF} onClick={() => onAlign('right')}><AlignEndVertical size={14} /></AlignBtn>
          <AlignBtn label="Align top" note={ALIGN_REF} onClick={() => onAlign('top')}><AlignStartHorizontal size={14} /></AlignBtn>
          <AlignBtn label="Centre vertically" note={ALIGN_REF} onClick={() => onAlign('vcenter')}><AlignCenterHorizontal size={14} /></AlignBtn>
          <AlignBtn label="Align bottom" note={ALIGN_REF} onClick={() => onAlign('bottom')}><AlignEndHorizontal size={14} /></AlignBtn>
        </div>
        <div className="mt-1 grid grid-cols-6 gap-1">
          <AlignBtn
            label="Distribute horizontally"
            note="Spaces the selection evenly left to right; the outermost two stay put."
            reason={spreadReason}
            onClick={() => onDistribute('horizontal')}
          >
            <AlignHorizontalSpaceAround size={14} />
          </AlignBtn>
          <AlignBtn
            label="Distribute vertically"
            note="Spaces the selection evenly top to bottom; the outermost two stay put."
            reason={spreadReason}
            onClick={() => onDistribute('vertical')}
          >
            <AlignVerticalSpaceAround size={14} />
          </AlignBtn>
          <AlignBtn
            label="Flip horizontally"
            note="Mirrors the selection left-to-right inside its own bounding box, so it doesn't move."
            onClick={() => onFlip('x')}
          >
            <FlipHorizontal size={14} />
          </AlignBtn>
          <AlignBtn
            label="Flip vertically"
            note="Mirrors the selection top-to-bottom inside its own bounding box, so it doesn't move."
            onClick={() => onFlip('y')}
          >
            <FlipVertical size={14} />
          </AlignBtn>
        </div>
      </Section>

      {box && (
        <Section title="Geometry">
          <div className="grid grid-cols-2 gap-2">
            <NumField label="X" tip="Left edge of the selection, in artboard units." value={box.x} onCommit={(v) => onGeometry({ x: v })} />
            <NumField label="Y" tip="Top edge of the selection, in artboard units." value={box.y} onCommit={(v) => onGeometry({ y: v })} />
            <NumField label="W" tip="Width. Resizes from the left edge, so X stays put." value={box.w} min={0.01} onCommit={(v) => onGeometry({ w: v })} />
            <NumField label="H" tip="Height. Resizes from the top edge, so Y stays put." value={box.h} min={0.01} onCommit={(v) => onGeometry({ h: v })} />
          </div>
        </Section>
      )}

      <Section title="Fill">
        <div className="flex items-center gap-2">
          <ColorWell
            label="Fill colour"
            note="Drag in the picker to preview live — the whole drag is one undo step."
            reason={paintReason}
            value={lead?.fill ?? '#000000'}
            onChange={(c) => onFill(c, true)}
          />
          <HexField
            tip="Fill colour as a hex code. Applies on Enter or when you leave the field."
            value={lead?.fill ?? '#000000'}
            onCommit={(hex) => onFill(hex)}
          />
          <ActionButton
            label="No fill"
            note="Clears the fill so the shape paints only its stroke, if it has one."
            reason={paintReason}
            onClick={() => onFill('none')}
            className={`btn btn-secondary h-8 px-2 text-xs ${lead?.fill === 'none' ? 'is-active' : ''}`}
          >
            None
          </ActionButton>
        </div>

        {palette.length > 0 && <Palette palette={palette} onPick={pickPaletteColor} />}

        <div className="mt-2">
          <SliderRow
            label="Opacity"
            tip="Fill opacity"
            note="How see-through the FILL is. The stroke has its own opacity, further down."
            value={Math.round((lead?.fillOpacity ?? 1) * 100)}
            onChange={(v) => onFillOpacity(v / 100, true)}
          />
        </div>

        {/* Fill RULE, not opacity — it sits under the slider but answers a
            different question: which parts of a path count as inside when the
            path has several subpaths or crosses itself. */}
        <div className="mt-2 flex gap-1">
          {FILL_RULES.map((r) => (
            <ActionButton
              key={r.id}
              label={r.label}
              note={r.note}
              reason={paintReason}
              onClick={() => onFillRule(r.id)}
              className={`btn btn-secondary h-7 flex-1 px-2 text-[0.7rem] ${
                lead?.fillRule === r.id ? 'is-active' : ''
              }`}
            >
              {r.short}
            </ActionButton>
          ))}
        </div>
      </Section>

      <StrokeSection stroke={lead?.stroke ?? null} onStroke={onStroke} />
    </div>
  )
}

function StrokeSection({
  stroke,
  onStroke,
}: {
  stroke: Stroke | null
  onStroke: (s: Stroke | null, live?: boolean) => void
}) {
  const on = stroke !== null
  const base: Stroke = stroke ?? { color: '#111827', width: 2, cap: 'butt', join: 'miter' }

  return (
    <Section title="Stroke">
      <div className="flex items-center gap-2">
        <ColorWell
          label="Stroke colour"
          note="Drag in the picker to preview live — the whole drag is one undo step."
          value={base.color}
          onChange={(c) => onStroke({ ...base, color: c }, true)}
        />
        <HexField
          tip="Stroke colour as a hex code. Applies on Enter or when you leave the field."
          value={base.color}
          onCommit={(c) => onStroke({ ...base, color: c })}
        />
        <ActionButton
          label={on ? 'Stroke on' : 'Stroke off'}
          note={on ? 'Click to remove the outline entirely.' : 'Click to give the selection an outline.'}
          onClick={() => onStroke(on ? null : base)}
          className={`btn btn-secondary h-8 px-2 text-xs ${on ? 'is-active' : ''}`}
        >
          {on ? 'On' : 'Off'}
        </ActionButton>
      </div>

      {on && (
        <>
          <div className="mt-2">
            <NumField
              label="Width"
              tip="Outline thickness, in artboard units. It straddles the path — half inside, half outside."
              value={base.width}
              min={0}
              onCommit={(v) => onStroke({ ...base, width: v })}
            />
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <SegRow
              label="Cap"
              value={base.cap}
              options={CAPS}
              onChange={(v) => onStroke({ ...base, cap: v as Stroke['cap'] })}
            />
            <SegRow
              label="Join"
              value={base.join}
              options={JOINS}
              onChange={(v) => onStroke({ ...base, join: v as Stroke['join'] })}
            />
          </div>
          <div className="mt-2">
            <SliderRow
              label="Opacity"
              tip="Stroke opacity"
              note="How see-through the OUTLINE is, independently of the fill."
              value={Math.round((base.opacity ?? 1) * 100)}
              onChange={(v) => onStroke({ ...base, opacity: v / 100 }, true)}
            />
          </div>
          <div className="mt-2 flex gap-1">
            {DASHES.map(({ dash, label, note }) => (
              <ActionButton
                key={label}
                label={label}
                note={note}
                onClick={() => onStroke({ ...base, dash: dash.length ? dash : undefined })}
                className={`btn btn-secondary h-7 flex-1 px-1 ${
                  (base.dash?.join(',') ?? '') === dash.join(',') ? 'is-active' : ''
                }`}
              >
                <svg width="34" height="8" aria-hidden>
                  <line
                    x1="1" y1="4" x2="33" y2="4"
                    stroke="currentColor" strokeWidth="2"
                    strokeDasharray={dash.length ? dash.join(' ') : undefined}
                    strokeLinecap="round"
                  />
                </svg>
              </ActionButton>
            ))}
          </div>
        </>
      )}
    </Section>
  )
}

/**
 * The document-colours strip. Memoized because it is the widest thing in the
 * rail — one node per distinct fill, which on traced art is hundreds — and it
 * has no reason to re-render for anything but its own list changing.
 */
const Palette = memo(function Palette({
  palette,
  onPick,
}: {
  palette: { color: string; count: number }[]
  onPick?: (color: string) => void
}) {
  // These keep the native `title` rather than a <Tooltip>: traced art has one
  // swatch per distinct fill, which runs to hundreds, and each Tooltip is a
  // component with its own state and portal. The strip is the one place in the
  // rail where the cheap tooltip is the right one.
  return (
    <div className={onPick ? 'mt-2 flex flex-wrap gap-1' : 'flex flex-wrap gap-1'}>
      {palette.map((p) =>
        onPick ? (
          <button
            key={p.color}
            type="button"
            title={`${p.color} — click to apply to the selection (${p.count} path${p.count === 1 ? '' : 's'} use it)`}
            onClick={() => onPick(p.color)}
            className="h-5 w-5 rounded ring-1 ring-line transition-transform hover:scale-110"
            style={{ backgroundColor: p.color }}
          />
        ) : (
          <span
            key={p.color}
            title={`${p.color} · ${p.count} path${p.count === 1 ? '' : 's'}`}
            className="h-5 w-5 rounded ring-1 ring-line"
            style={{ backgroundColor: p.color }}
          />
        ),
      )}
    </div>
  )
})

/* ---------------------------------------------------------------- copy */

/** Align aims at the artboard for one item and at the selection for several. */
const ALIGN_REF =
  'With one item selected this aligns to the artboard; with several, to the selection\u2019s own bounds.'

const FILL_RULES = [
  {
    id: 'nonzero' as const,
    short: 'Non-zero',
    label: 'Non-zero fill rule',
    note: 'Counts overlaps by direction: a hole appears only where a subpath winds the opposite way to the one around it. The SVG default.',
  },
  {
    id: 'evenodd' as const,
    short: 'Even-odd',
    label: 'Even-odd fill rule',
    note: 'Counts overlaps regardless of direction: every second layer of overlap becomes a hole. Reach for it when a counter fills in solid.',
  },
]

const CAPS = [
  { id: 'butt', label: 'Butt cap', note: 'The line stops dead at its end point.' },
  { id: 'round', label: 'Round cap', note: 'A half-circle carries past each end.' },
  { id: 'square', label: 'Square cap', note: 'A half-square carries past each end.' },
]

const JOINS = [
  { id: 'miter', label: 'Miter join', note: 'Corners run out to a sharp point.' },
  { id: 'round', label: 'Round join', note: 'Corners are rounded off.' },
  { id: 'bevel', label: 'Bevel join', note: 'Corners are cut flat.' },
]

const DASHES = [
  { dash: [] as number[], label: 'Solid line', note: 'An unbroken outline.' },
  { dash: [6, 4], label: 'Dashed line', note: 'Six units on, four off.' },
  { dash: [1, 4], label: 'Dotted line', note: 'Round dots, four units apart.' },
]

/* ------------------------------------------------------------- controls */

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h4 className="field-label mb-1.5">{title}</h4>
      {children}
    </section>
  )
}

function AlignBtn({
  label, note, onClick, reason, children,
}: {
  label: string
  note?: string
  onClick: () => void
  reason?: string | null
  children: React.ReactNode
}) {
  const off = isOff(reason)
  return (
    <ActionButton
      label={label}
      note={note}
      reason={reason}
      onClick={onClick}
      className={`flex h-7 items-center justify-center rounded-md border border-line-strong bg-surface text-ink-2 transition-colors ${
        off ? 'cursor-not-allowed opacity-40' : 'hover:bg-surface-3 hover:text-ink'
      }`}
    >
      {children}
    </ActionButton>
  )
}

function ColorWell({
  value, onChange, label, note, reason,
}: {
  value: string
  onChange: (v: string) => void
  label: string
  note?: string
  reason?: string | null
}) {
  // `none` is the absence of paint, not a colour — showing the picker's black
  // fallback would claim the shape is filled black, which is exactly what the
  // user is looking at the well to find out.
  const none = value.trim().toLowerCase() === 'none'
  const off = isOff(reason)
  // The tooltip goes on the WELL, not the input: a disabled input is silent
  // (see ui/ActionButton.tsx), and focus bubbles, so the swatch hears both the
  // hover and the keyboard focus of the picker inside it.
  return (
    <Tooltip label={<TipLabel title={none ? `${label} — none` : label} detail={off ? reason : note} />}>
    <span
      className={`relative h-8 w-8 shrink-0 overflow-hidden rounded-md ring-1 ring-line-strong ${
        none ? 'checkerboard' : ''
      } ${off ? 'opacity-40' : ''}`}
    >
      {none ? (
        <svg viewBox="0 0 32 32" className="absolute inset-0 h-full w-full" aria-hidden>
          <line x1="4" y1="28" x2="28" y2="4" stroke="#d6453d" strokeWidth="3" />
        </svg>
      ) : (
        <span className="absolute inset-0" style={{ backgroundColor: value }} />
      )}
      <input
        type="color"
        value={normalizeHex(value) ?? '#000000'}
        aria-disabled={off || undefined}
        onChange={off ? undefined : (e) => onChange(e.target.value)}
        className={`absolute inset-0 opacity-0 ${off ? 'cursor-not-allowed' : 'cursor-pointer'}`}
        aria-label={label}
      />
    </span>
    </Tooltip>
  )
}

function HexField({ value, onCommit, tip }: { value: string; onCommit: (v: string) => void; tip: string }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const commit = () => {
    const hex = normalizeHex(draft)
    if (hex) onCommit(hex)
    else setDraft(value)
  }
  return (
    <Tooltip label={tip}>
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') {
            setDraft(value)
            e.currentTarget.blur()
          }
          e.stopPropagation()
        }}
        spellCheck={false}
        className="input h-8 min-w-0 flex-1 font-mono text-xs"
      />
    </Tooltip>
  )
}

function NumField({
  label, value, onCommit, min, tip,
}: { label: string; value: number; onCommit: (v: number) => void; min?: number; tip: string }) {
  const shown = String(Number(value.toFixed(2)))
  const [draft, setDraft] = useState(shown)
  useEffect(() => setDraft(shown), [shown])
  const commit = () => {
    const n = Number(draft)
    if (Number.isFinite(n) && (min === undefined || n >= min)) onCommit(n)
    else setDraft(shown)
  }
  // The tooltip goes on the INPUT, not on the <label> around it. Wrapping the
  // label means focus arrives by bubbling from a child, and a bubble opened
  // that way can be left stranded when focus leaves by a route the label never
  // hears — the trigger should be the thing that actually takes focus.
  return (
    <label className="flex items-center gap-1.5">
      <span className="w-8 shrink-0 text-[0.7rem] text-muted">{label}</span>
      <Tooltip label={<TipLabel title={label} detail={tip} />}>
        <input
          value={draft}
          inputMode="decimal"
          aria-label={label}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
            if (e.key === 'Escape') {
              setDraft(shown)
              e.currentTarget.blur()
            }
            e.stopPropagation()
          }}
          className="input h-8 min-w-0 flex-1 text-xs"
        />
      </Tooltip>
    </label>
  )
}

function SliderRow({
  label, tip, note, value, onChange,
}: { label: string; tip: string; note: string; value: number; onChange: (v: number) => void }) {
  return (
    <label className="flex items-center gap-2">
      <span className="w-14 shrink-0 text-[0.7rem] text-muted">{label}</span>
      <Tooltip label={<TipLabel title={tip} detail={note} />}>
        <input
          type="range"
          min={0}
          max={100}
          value={value}
          aria-label={tip}
          onChange={(e) => onChange(Number(e.target.value))}
          className="min-w-0 flex-1 accent-[var(--color-accent)]"
        />
      </Tooltip>
      <span className="w-9 shrink-0 text-right text-[0.7rem] tabular-nums text-muted">{value}%</span>
    </label>
  )
}

function SegRow({
  label, value, options, onChange,
}: {
  label: string
  value: string
  options: { id: string; label: string; note: string }[]
  onChange: (v: string) => void
}) {
  return (
    <div>
      <span className="mb-1 block text-[0.7rem] text-muted">{label}</span>
      <div className="flex gap-0.5">
        {options.map((o) => (
          <ActionButton
            key={o.id}
            label={o.label}
            note={o.note}
            onClick={() => onChange(o.id)}
            className={`btn btn-secondary h-7 flex-1 px-1 text-[0.65rem] capitalize ${
              value === o.id ? 'is-active' : ''
            }`}
          >
            {o.id}
          </ActionButton>
        ))}
      </div>
    </div>
  )
}
