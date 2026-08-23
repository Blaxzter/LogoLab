// The properties rail: paint, geometry and alignment for the current selection.
//
// Every numeric field is a "commit on blur / Enter, preview never" control. A
// field that applied on each keystroke would push one undo step per digit and
// would fight you the moment you cleared it to retype — so the draft lives in
// local state until you leave the field.

import { useEffect, useState } from 'react'
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
import { Tooltip } from '../ui/Tooltip'
import { normalizeHex } from '../../lib/colorUtils'
import { docPalette } from './editorDoc'

export interface InspectorProps {
  doc: EditableDoc
  selection: ReadonlySet<string>
  box: Box | null
  onFill: (fill: string) => void
  onFillOpacity: (v: number) => void
  onFillRule: (rule: 'nonzero' | 'evenodd') => void
  onStroke: (stroke: Stroke | null) => void
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
  const palette = docPalette(doc)

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
            <div className="flex flex-wrap gap-1">
              {palette.map((p) => (
                <span
                  key={p.color}
                  title={`${p.color} · ${p.count} path${p.count === 1 ? '' : 's'}`}
                  className="h-5 w-5 rounded ring-1 ring-line"
                  style={{ backgroundColor: p.color }}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4 p-3">
      <Section title="Arrange">
        <div className="grid grid-cols-6 gap-1">
          <AlignBtn label="Align left" onClick={() => onAlign('left')}><AlignStartVertical size={14} /></AlignBtn>
          <AlignBtn label="Centre horizontally" onClick={() => onAlign('hcenter')}><AlignCenterVertical size={14} /></AlignBtn>
          <AlignBtn label="Align right" onClick={() => onAlign('right')}><AlignEndVertical size={14} /></AlignBtn>
          <AlignBtn label="Align top" onClick={() => onAlign('top')}><AlignStartHorizontal size={14} /></AlignBtn>
          <AlignBtn label="Centre vertically" onClick={() => onAlign('vcenter')}><AlignCenterHorizontal size={14} /></AlignBtn>
          <AlignBtn label="Align bottom" onClick={() => onAlign('bottom')}><AlignEndHorizontal size={14} /></AlignBtn>
        </div>
        <div className="mt-1 grid grid-cols-6 gap-1">
          <AlignBtn label="Distribute horizontally" disabled={!canDistribute} onClick={() => onDistribute('horizontal')}>
            <AlignHorizontalSpaceAround size={14} />
          </AlignBtn>
          <AlignBtn label="Distribute vertically" disabled={!canDistribute} onClick={() => onDistribute('vertical')}>
            <AlignVerticalSpaceAround size={14} />
          </AlignBtn>
          <AlignBtn label="Flip horizontally" onClick={() => onFlip('x')}><FlipHorizontal size={14} /></AlignBtn>
          <AlignBtn label="Flip vertically" onClick={() => onFlip('y')}><FlipVertical size={14} /></AlignBtn>
        </div>
      </Section>

      {box && (
        <Section title="Geometry">
          <div className="grid grid-cols-2 gap-2">
            <NumField label="X" value={box.x} onCommit={(v) => onGeometry({ x: v })} />
            <NumField label="Y" value={box.y} onCommit={(v) => onGeometry({ y: v })} />
            <NumField label="W" value={box.w} min={0.01} onCommit={(v) => onGeometry({ w: v })} />
            <NumField label="H" value={box.h} min={0.01} onCommit={(v) => onGeometry({ h: v })} />
          </div>
        </Section>
      )}

      <Section title="Fill">
        <div className="flex items-center gap-2">
          <ColorWell value={lead?.fill ?? '#000000'} disabled={!lead} onChange={onFill} />
          <HexField
            value={lead?.fill ?? '#000000'}
            onCommit={(hex) => onFill(hex)}
          />
          <Tooltip label="No fill">
            <button
              type="button"
              onClick={() => onFill('none')}
              className={`btn btn-secondary h-8 px-2 text-xs ${lead?.fill === 'none' ? 'is-active' : ''}`}
            >
              None
            </button>
          </Tooltip>
        </div>

        {palette.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {palette.map((p) => (
              <button
                key={p.color}
                type="button"
                title={p.color}
                onClick={() => onFill(p.color)}
                className="h-5 w-5 rounded ring-1 ring-line transition-transform hover:scale-110"
                style={{ backgroundColor: p.color }}
              />
            ))}
          </div>
        )}

        <div className="mt-2">
          <SliderRow
            label="Opacity"
            value={Math.round((lead?.fillOpacity ?? 1) * 100)}
            onChange={(v) => onFillOpacity(v / 100)}
          />
        </div>

        <div className="mt-2 flex gap-1">
          {(['nonzero', 'evenodd'] as const).map((rule) => (
            <button
              key={rule}
              type="button"
              onClick={() => onFillRule(rule)}
              className={`btn btn-secondary h-7 flex-1 px-2 text-[0.7rem] ${
                lead?.fillRule === rule ? 'is-active' : ''
              }`}
            >
              {rule === 'nonzero' ? 'Non-zero' : 'Even-odd'}
            </button>
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
  onStroke: (s: Stroke | null) => void
}) {
  const on = stroke !== null
  const base: Stroke = stroke ?? { color: '#111827', width: 2, cap: 'butt', join: 'miter' }

  return (
    <Section title="Stroke">
      <div className="flex items-center gap-2">
        <ColorWell value={base.color} onChange={(c) => onStroke({ ...base, color: c })} />
        <HexField value={base.color} onCommit={(c) => onStroke({ ...base, color: c })} />
        <button
          type="button"
          onClick={() => onStroke(on ? null : base)}
          className={`btn btn-secondary h-8 px-2 text-xs ${on ? 'is-active' : ''}`}
        >
          {on ? 'On' : 'Off'}
        </button>
      </div>

      {on && (
        <>
          <div className="mt-2">
            <NumField label="Width" value={base.width} min={0} onCommit={(v) => onStroke({ ...base, width: v })} />
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <SegRow
              label="Cap"
              value={base.cap}
              options={['butt', 'round', 'square']}
              onChange={(v) => onStroke({ ...base, cap: v as Stroke['cap'] })}
            />
            <SegRow
              label="Join"
              value={base.join}
              options={['miter', 'round', 'bevel']}
              onChange={(v) => onStroke({ ...base, join: v as Stroke['join'] })}
            />
          </div>
          <div className="mt-2">
            <SliderRow
              label="Opacity"
              value={Math.round((base.opacity ?? 1) * 100)}
              onChange={(v) => onStroke({ ...base, opacity: v / 100 })}
            />
          </div>
          <div className="mt-2 flex gap-1">
            {([[], [6, 4], [1, 4]] as number[][]).map((dash, i) => (
              <button
                key={i}
                type="button"
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
              </button>
            ))}
          </div>
        </>
      )}
    </Section>
  )
}

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
  label, onClick, disabled, children,
}: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <Tooltip label={label}>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        className="flex h-7 items-center justify-center rounded-md border border-line-strong bg-surface text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink disabled:opacity-40 disabled:hover:bg-surface"
      >
        {children}
      </button>
    </Tooltip>
  )
}

function ColorWell({
  value, onChange, disabled,
}: { value: string; onChange: (v: string) => void; disabled?: boolean }) {
  // `none` is the absence of paint, not a colour — showing the picker's black
  // fallback would claim the shape is filled black, which is exactly what the
  // user is looking at the well to find out.
  const none = value.trim().toLowerCase() === 'none'
  return (
    <span
      className={`relative h-8 w-8 shrink-0 overflow-hidden rounded-md ring-1 ring-line-strong ${
        none ? 'checkerboard' : ''
      }`}
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
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="absolute inset-0 cursor-pointer opacity-0"
        aria-label="Colour"
      />
    </span>
  )
}

function HexField({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const commit = () => {
    const hex = normalizeHex(draft)
    if (hex) onCommit(hex)
    else setDraft(value)
  }
  return (
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
  )
}

function NumField({
  label, value, onCommit, min,
}: { label: string; value: number; onCommit: (v: number) => void; min?: number }) {
  const shown = String(Number(value.toFixed(2)))
  const [draft, setDraft] = useState(shown)
  useEffect(() => setDraft(shown), [shown])
  const commit = () => {
    const n = Number(draft)
    if (Number.isFinite(n) && (min === undefined || n >= min)) onCommit(n)
    else setDraft(shown)
  }
  return (
    <label className="flex items-center gap-1.5">
      <span className="w-8 shrink-0 text-[0.7rem] text-muted">{label}</span>
      <input
        value={draft}
        inputMode="decimal"
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
    </label>
  )
}

function SliderRow({
  label, value, onChange,
}: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <label className="flex items-center gap-2">
      <span className="w-14 shrink-0 text-[0.7rem] text-muted">{label}</span>
      <input
        type="range"
        min={0}
        max={100}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="min-w-0 flex-1 accent-[var(--color-accent)]"
      />
      <span className="w-9 shrink-0 text-right text-[0.7rem] tabular-nums text-muted">{value}%</span>
    </label>
  )
}

function SegRow({
  label, value, options, onChange,
}: { label: string; value: string; options: string[]; onChange: (v: string) => void }) {
  return (
    <div>
      <span className="mb-1 block text-[0.7rem] text-muted">{label}</span>
      <div className="flex gap-0.5">
        {options.map((o) => (
          <button
            key={o}
            type="button"
            onClick={() => onChange(o)}
            className={`btn btn-secondary h-7 flex-1 px-1 text-[0.65rem] capitalize ${
              value === o ? 'is-active' : ''
            }`}
          >
            {o}
          </button>
        ))}
      </div>
    </div>
  )
}
