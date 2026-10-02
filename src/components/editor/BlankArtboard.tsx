// "Start blank": pick an artboard, get an empty document.
//
// Every control writes the same width/height pair (presets set it, orientation
// swaps it, the fields type it), so they can't disagree. The size is a choice,
// not a requirement: "Grow" makes it the starting area of an artboard that then
// follows the drawing in every direction.

import { useState } from 'react'
import { FilePlus2, RectangleHorizontal, RectangleVertical } from 'lucide-react'
import { useCheckerClass } from '../../state/store'
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
  onCreate: (width: number, height: number, grow: boolean) => void
}

/** A typed field's value, once it means a usable artboard edge. */
const parseEdge = (text: string): number | null => {
  const n = Math.round(Number(text.trim()))
  if (!text.trim() || !Number.isFinite(n) || n < MIN_ARTBOARD || n > MAX_ARTBOARD) return null
  return n
}

export function BlankArtboard({ onCreate }: BlankArtboardProps) {
  // Kept as text so a half-typed number isn't clamped mid-typing.
  const [wText, setWText] = useState('512')
  const [hText, setHText] = useState('512')
  const [grow, setGrow] = useState(false)

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
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="field-label w-14 shrink-0">Size</span>
            <ActionButton
              label="Fixed size"
              note="The artboard is exactly this size. Anything drawn outside it is cropped from the export."
              pressed={!grow}
              onClick={() => setGrow(false)}
              className={`btn btn-secondary h-8 px-2.5 text-xs ${grow ? '' : 'is-active'}`}
            >
              Fixed
            </ActionButton>
            <ActionButton
              label="Grow with the drawing"
              note="No size to pick. An endless board you can pan and zoom anywhere; the artboard wraps whatever you draw."
              pressed={grow}
              onClick={() => setGrow(true)}
              className={`btn btn-secondary h-8 px-2.5 text-xs ${grow ? 'is-active' : ''}`}
            >
              Grow
            </ActionButton>
          </div>
          {grow ? (
            <GrowNotes />
          ) : (
            <>
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
                Sizes are artboard units, which a browser draws as pixels — so the paper presets are their millimetres
                at 96 dpi and print at the real sheet size. The artboard can be resized, or switched to Grow, later.
              </p>
            </>
          )}
        </div>

        {/* What you are about to get */}
        <div className="flex w-full shrink-0 flex-col items-center gap-2 sm:w-44">
          {grow ? <BoardPreview /> : <ArtboardPreview width={w} height={h} />}
          <p className="text-center text-xs text-muted">
            {grow ? (
              <>
                <span className="font-medium text-ink">Endless board</span> sized by the drawing
              </>
            ) : sized ? (
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
            note={
              grow
                ? 'Opens an empty document with no size limit. Press R or E and drag to draw the first shape.'
                : 'Opens an empty document at this size. Press R or E and drag to draw the first shape.'
            }
            reason={
              grow || sized
                ? null
                : `An artboard edge is a whole number from ${MIN_ARTBOARD} to ${MAX_ARTBOARD} — one of the two fields is not.`
            }
            onClick={() => {
              if (grow) onCreate(GROW_START, GROW_START, true)
              else if (sized) onCreate(w, h, false)
            }}
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

/**
 * A growing board's empty extent, in units. It only sets how far in the empty
 * board starts zoomed — the artboard is the drawing's bounds from the first
 * shape on — so it is not offered as a choice.
 */
const GROW_START = 512

/** What Grow means, in place of the size controls it has no use for. */
function GrowNotes() {
  return (
    <ul className="flex list-disc flex-col gap-1.5 pl-5 text-xs leading-relaxed text-muted">
      <li>
        <span className="text-ink">No size to pick.</span> The board is endless: pan with Space-drag or the middle
        button, zoom with the wheel, and draw anywhere.
      </li>
      <li>
        <span className="text-ink">The artboard follows the drawing.</span> It wraps what you have placed, in every
        direction, and the export is cropped to exactly that.
      </li>
      <li>
        <span className="text-ink">Need a set size after all?</span> Switch to Fixed in the Properties panel at any time
        — the artboard keeps the size it has grown to, and you can type a new one there.
      </li>
    </ul>
  )
}

/**
 * The endless board: checker running off every edge, and a dashed artboard
 * hugging the shapes on it with room to grow outward.
 */
function BoardPreview() {
  const checkerClass = useCheckerClass()
  const fade = 'radial-gradient(ellipse at center, #000 45%, transparent 85%)'
  return (
    <div className="relative h-28 w-full overflow-hidden rounded-lg border border-line bg-surface-2">
      <div
        className={`absolute inset-0 ${checkerClass}`}
        style={{ maskImage: fade, WebkitMaskImage: fade }}
        aria-hidden
      />
      <svg viewBox="0 0 160 100" className="absolute inset-0 h-full w-full" aria-hidden>
        <g className="text-accent" stroke="currentColor" fill="none" strokeWidth={1.2} strokeLinecap="round">
          <rect x={52} y={30} width={56} height={40} strokeDasharray="3 2.5" />
          {/* Room to grow, every way. */}
          <path d="M80 24v-12m-3 3 3-3 3 3M80 76v12m-3-3 3 3 3-3M46 50H32m3-3-3 3 3 3M114 50h14m-3-3 3 3-3 3" />
        </g>
        <rect x={56} y={44} width={20} height={22} rx={2} className="fill-accent" />
        <circle cx={93} cy={44} r={10} className="fill-accent" opacity={0.75} />
      </svg>
    </div>
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
 * The artboard's shape, to scale, on the app's transparency checker.
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
