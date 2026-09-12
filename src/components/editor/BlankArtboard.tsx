// "Start blank": pick an artboard, get an empty document.
//
// One piece of state — the width and the height — and every control writes it.
// The presets are shortcuts into that pair, orientation only reorders it, and
// the two fields are the same numbers typed by hand, so no control here can
// disagree with another. The preview and the button both spell the result out,
// so the artboard is readable before you commit to it.

import { useState } from 'react'
import { FilePlus2, RectangleHorizontal, RectangleVertical } from 'lucide-react'
import { useCheckerClass } from '../../store'
import { ActionButton } from '../ui/ActionButton'
import {
  MAX_ARTBOARD,
  MIN_ARTBOARD,
  PAPER_PRESETS,
  SQUARE_PRESETS,
  describeArtboard,
  presetMatches,
  type ArtboardPreset,
} from './artboards'

export interface BlankArtboardProps {
  onCreate: (width: number, height: number) => void
}

/** A typed field's value, once it means a usable artboard edge. */
const parseEdge = (text: string): number | null => {
  const n = Math.round(Number(text.trim()))
  if (!text.trim() || !Number.isFinite(n) || n < MIN_ARTBOARD || n > MAX_ARTBOARD) return null
  return n
}

export function BlankArtboard({ onCreate }: BlankArtboardProps) {
  // Kept as text so a half-typed number ("12" on the way to "1200") is not
  // snapped out from under the cursor; the parsed pair is what everything reads.
  const [wText, setWText] = useState('512')
  const [hText, setHText] = useState('512')

  const w = parseEdge(wText)
  const h = parseEdge(hText)
  const sized = w !== null && h !== null

  const set = (width: number, height: number) => {
    setWText(String(width))
    setHText(String(height))
  }

  /** Apply a preset in the orientation the artboard is already in. */
  const applyPreset = (p: ArtboardPreset) => {
    const wide = sized && w > h
    set(wide ? p.height : p.width, wide ? p.width : p.height)
  }

  /** Reorder the pair. Portrait = the long edge is the height. */
  const orient = (portrait: boolean) => {
    if (!sized) return
    const long = Math.max(w, h)
    const short = Math.min(w, h)
    set(portrait ? short : long, portrait ? long : short)
  }

  const square = sized && w === h
  const portrait = sized && h > w
  const landscape = sized && w > h
  const noSize = 'Type a width and a height first.'
  const sameShape = 'The artboard is square — portrait and landscape are the same shape.'

  return (
    <section className="rounded-xl border border-line bg-surface p-4">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
        {/* The picker */}
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <PresetRow label="Square" presets={SQUARE_PRESETS} width={w} height={h} onPick={applyPreset} />
          <PresetRow label="Paper" presets={PAPER_PRESETS} width={w} height={h} onPick={applyPreset} />

          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1">
              <span className="field-label">Width</span>
              <input
                type="number"
                inputMode="numeric"
                min={MIN_ARTBOARD}
                max={MAX_ARTBOARD}
                value={wText}
                onChange={(e) => setWText(e.target.value)}
                className="input h-8 w-24 text-sm"
              />
            </label>
            <span className="pb-2 text-xs text-faint">×</span>
            <label className="flex flex-col gap-1">
              <span className="field-label">Height</span>
              <input
                type="number"
                inputMode="numeric"
                min={MIN_ARTBOARD}
                max={MAX_ARTBOARD}
                value={hText}
                onChange={(e) => setHText(e.target.value)}
                className="input h-8 w-24 text-sm"
              />
            </label>

            <div className="ml-1 flex flex-col gap-1">
              <span className="field-label">Shape</span>
              <div className="flex gap-1">
                <ActionButton
                  label="Portrait"
                  note="Stands the long edge upright."
                  reason={!sized ? noSize : square ? sameShape : null}
                  pressed={portrait}
                  onClick={() => orient(true)}
                  className={`btn btn-secondary h-8 w-8 px-0 ${portrait ? 'is-active' : ''}`}
                >
                  <RectangleVertical size={14} />
                </ActionButton>
                <ActionButton
                  label="Landscape"
                  note="Lays the long edge across."
                  reason={!sized ? noSize : square ? sameShape : null}
                  pressed={landscape}
                  onClick={() => orient(false)}
                  className={`btn btn-secondary h-8 w-8 px-0 ${landscape ? 'is-active' : ''}`}
                >
                  <RectangleHorizontal size={14} />
                </ActionButton>
              </div>
            </div>
          </div>

          <p className="text-xs leading-relaxed text-faint">
            Sizes are artboard units, which a browser draws as pixels — so the paper presets are
            their millimetres at 96 dpi and print at the real sheet size. The artboard can be
            resized later.
          </p>
        </div>

        {/* What you are about to get */}
        <div className="flex w-full shrink-0 flex-col items-center gap-2 sm:w-44">
          <ArtboardPreview width={w} height={h} />
          <p className="text-center text-xs text-muted">
            {sized ? (
              <>
                <span className="font-medium text-ink">
                  {w} × {h}
                </span>{' '}
                {describeArtboard(w, h)}
              </>
            ) : (
              'No size yet'
            )}
          </p>
          <ActionButton
            label="New artboard"
            note="Opens an empty document at this size. Press R or E and drag to draw the first shape."
            reason={
              sized
                ? null
                : `An artboard edge is a whole number from ${MIN_ARTBOARD} to ${MAX_ARTBOARD} — one of the two fields is not.`
            }
            onClick={() => sized && onCreate(w, h)}
            className="btn btn-primary h-9 w-full text-sm"
          >
            <FilePlus2 size={15} />
            New artboard
          </ActionButton>
        </div>
      </div>
    </section>
  )
}

/** One labelled row of size shortcuts. */
function PresetRow({
  label,
  presets,
  width,
  height,
  onPick,
}: {
  label: string
  presets: ArtboardPreset[]
  width: number | null
  height: number | null
  onPick: (p: ArtboardPreset) => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="field-label w-14 shrink-0">{label}</span>
      {presets.map((p) => {
        const on = width !== null && height !== null && presetMatches(p, width, height)
        return (
          <ActionButton
            key={p.id}
            label={`${p.label} — ${p.width} × ${p.height}`}
            note={p.note}
            pressed={on}
            onClick={() => onPick(p)}
            className={`btn btn-secondary h-8 px-2.5 text-xs ${on ? 'is-active' : ''}`}
          >
            {p.label}
          </ActionButton>
        )
      })}
    </div>
  )
}

/**
 * The artboard's shape, to scale, on the transparency checker — the app's
 * chosen one, so this is the empty canvas you are about to be looking at
 * rather than a generic rectangle.
 */
function ArtboardPreview({ width, height }: { width: number | null; height: number | null }) {
  const checkerClass = useCheckerClass()
  const sized = width !== null && height !== null
  const scale = sized ? 100 / Math.max(width, height) : 0
  return (
    <div className="flex h-28 w-full items-center justify-center rounded-lg border border-line bg-surface-2 p-2">
      {sized ? (
        <div
          style={{ width: `${width * scale}%`, height: `${height * scale}%` }}
          className={`${checkerClass} rounded-sm border border-line-strong`}
        />
      ) : (
        <span className="text-xs text-faint">No size</span>
      )}
    </div>
  )
}
