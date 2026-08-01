// Editable flat-art palette for the vectorize studio (lives in the right rail,
// below the Paths list). The flat (gradients-off) tracer reduces the art to a
// small set of dominant colours (paletteSegment.ts); this surfaces that palette
// so the user can take it over: eyedrop a colour from the image, tweak a hex, set
// an opacity, add a missed colour, or remove one (its areas merge into the nearest
// remaining colour). A locked palette flows into the tracer as `opts.palette` —
// every pixel snaps to the nearest of THESE colours, the user owns the count (the
// automatic ≤14-colour / coverage gates are bypassed), and each swatch's opacity
// paints its region's `fill-opacity` (planar engine).
//
// Default stays fully automatic: until the user clicks "Edit", `opts.palette` is
// undefined and the colours are extracted + snapped to true design hex (and each
// region's alpha mode) by the pipeline. An optional reveal — colours only, no chrome.

import { useState } from 'react'
import { Pipette, Plus, RotateCcw, X } from 'lucide-react'
import { hexToRgb, rgbToHex } from '../../lib/colorUtils'

type RGB = { r: number; g: number; b: number; a?: number }

/** Native screen eye-dropper (Chromium only) — feature-detected, never assumed. */
type EyeDropperOpen = () => Promise<{ sRGBHex: string }>
const eyeDropperCtor = (): (new () => { open: EyeDropperOpen }) | undefined =>
  (window as unknown as { EyeDropper?: new () => { open: EyeDropperOpen } }).EyeDropper

const clamp255 = (n: number): number => Math.max(0, Math.min(255, Math.round(n)))
const to2 = (n: number): string => clamp255(n).toString(16).padStart(2, '0')
const pct = (a: number | undefined): number => Math.round(((a ?? 255) / 255) * 100)

/** {r,g,b,a} → #rrggbb, or #rrggbbaa when translucent (for tooltips / paste). */
function hexA(c: RGB): string {
  const base = '#' + to2(c.r) + to2(c.g) + to2(c.b)
  return c.a === undefined || c.a >= 255 ? base : base + to2(c.a)
}

/** Parse #rgb / #rgba / #rrggbb / #rrggbbaa → {r,g,b,a?}. `a` omitted when opaque. */
function parseHexA(raw: string): RGB | null {
  const v = raw.trim().replace(/^#/, '')
  let h: string
  if (/^[0-9a-fA-F]{3}$/.test(v)) h = v.split('').map((c) => c + c).join('') + 'ff'
  else if (/^[0-9a-fA-F]{4}$/.test(v)) h = v.split('').map((c) => c + c).join('')
  else if (/^[0-9a-fA-F]{6}$/.test(v)) h = v + 'ff'
  else if (/^[0-9a-fA-F]{8}$/.test(v)) h = v
  else return null
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  const a = parseInt(h.slice(6, 8), 16)
  return a < 255 ? { r, g, b, a } : { r, g, b }
}

export interface PaletteEditorProps {
  /** The auto-extracted palette of the current trace (distinct solid fills + alpha,
   *  in paint order). Shown read-only when unlocked, and used to seed editing. */
  autoPalette: RGB[]
  /** The user-locked palette (opts.palette) or null when fully automatic. */
  locked: RGB[] | null
  /** Patch opts.palette: an array locks it; null reverts to automatic. */
  onChange: (palette: RGB[] | null) => void
  /** Hovering a swatch passes its fill so the canvas lights up that colour's regions
   *  (locate-before-delete); null on leave. */
  onHighlight?: (fill: string | null) => void
}

/** A colour chip showing the entry over a checker so translucency is visible. */
function Chip({ c, onHighlight }: { c: RGB; onHighlight?: (fill: string | null) => void }) {
  return (
    <span
      title={`${hexA(c)} · ${pct(c.a)}%`}
      onPointerEnter={() => onHighlight?.(rgbToHex(c))}
      onPointerLeave={() => onHighlight?.(null)}
      className="checkerboard h-6 w-6 shrink-0 overflow-hidden rounded-md border border-line-strong shadow-xs"
    >
      <span className="block h-full w-full" style={{ backgroundColor: rgbToHex(c), opacity: (c.a ?? 255) / 255 }} />
    </span>
  )
}

export function PaletteEditor({ autoPalette, locked, onChange, onHighlight }: PaletteEditorProps) {
  const isLocked = locked != null && locked.length > 0
  const hasEyeDropper = eyeDropperCtor() !== undefined

  // --- Automatic (unlocked): preview the extracted colours; "Edit" takes over. ---
  if (!isLocked) {
    return (
      <>
        <p className="text-xs leading-snug text-muted">
          The flat colours your art reduces to. <em>Edit</em> to take over — eyedrop, tweak a hex,
          set an opacity, or add/remove a colour. Left automatic, they snap to the true design
          colours (and each region's opacity).
        </p>
        {autoPalette.length > 0 ? (
          <>
            <div className="flex flex-wrap gap-1.5">
              {autoPalette.map((c, i) => (
                <Chip key={`${hexA(c)}-${i}`} c={c} onHighlight={onHighlight} />
              ))}
            </div>
            <button
              type="button"
              onClick={() => onChange(autoPalette.map((c) => ({ ...c })))}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-line px-3 py-2 text-sm font-medium text-ink-2 transition-colors hover:bg-surface-2"
            >
              <Pipette size={14} />
              Edit palette ({autoPalette.length})
            </button>
          </>
        ) : (
          <p className="text-xs leading-snug text-muted">Trace the image to read its palette.</p>
        )}
      </>
    )
  }

  // --- Locked: the user owns the colours, opacities and the count. ---
  const palette = locked!
  const replaceAt = (i: number, c: RGB) => onChange(palette.map((p, j) => (j === i ? c : p)))
  const removeAt = (i: number) => {
    const next = palette.filter((_, j) => j !== i)
    onChange(next.length > 0 ? next : null) // never lock an empty palette
  }
  const addColor = (c: RGB) => onChange([...palette, c])
  const eyedrop = async () => {
    const Ctor = eyeDropperCtor()
    if (!Ctor) return
    try {
      const { sRGBHex } = await new Ctor().open()
      const c = hexToRgb(sRGBHex)
      if (c) addColor(c) // opaque — the screen picker has no alpha
    } catch {
      // User dismissed the picker (Escape) — nothing to do.
    }
  }

  return (
    <>
      <div className="flex items-center justify-between">
        <span className="text-xs text-ink-2">
          {palette.length} colour{palette.length === 1 ? '' : 's'} · locked
        </span>
        <button
          type="button"
          onClick={() => onChange(null)}
          className="flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink"
        >
          <RotateCcw size={12} /> Automatic
        </button>
      </div>

      <div className="flex flex-col gap-1.5">
        {palette.map((c, i) => (
          <SwatchRow
            key={i}
            value={c}
            canRemove={palette.length > 1}
            onChange={(next) => replaceAt(i, next)}
            onRemove={() => removeAt(i)}
            onHighlight={onHighlight}
          />
        ))}
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => addColor({ r: 128, g: 128, b: 128 })}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-line px-2 py-1.5 text-xs font-medium text-ink-2 transition-colors hover:bg-surface-2"
        >
          <Plus size={13} /> Add
        </button>
        {hasEyeDropper && (
          <button
            type="button"
            onClick={() => void eyedrop()}
            title="Pick a colour from anywhere on screen"
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-line px-2 py-1.5 text-xs font-medium text-ink-2 transition-colors hover:bg-surface-2"
          >
            <Pipette size={13} /> Eyedrop
          </button>
        )}
      </div>
      <p className="text-xs leading-snug text-muted">
        Every pixel snaps to its nearest colour here. Drag a swatch's slider for a translucent fill.
        Remove a colour to merge its areas into the nearest remaining one.
      </p>
    </>
  )
}

/** One editable swatch: colour well + hex field + opacity slider + remove. The
 *  well/hex edit RGB; the slider edits alpha — independent, so changing opacity
 *  never reassigns which region the colour owns. */
function SwatchRow({
  value,
  canRemove,
  onChange,
  onRemove,
  onHighlight,
}: {
  value: RGB
  canRemove: boolean
  onChange: (c: RGB) => void
  onRemove: () => void
  onHighlight?: (fill: string | null) => void
}) {
  const rgb6 = rgbToHex(value)
  const a = value.a ?? 255
  const [text, setText] = useState(rgb6)
  // Resync the hex field when the RGB changes (e.g. removing a swatch shifts colours
  // up a row). Done in render — not an effect — so the well and the field never
  // disagree for a frame; an alpha-only change leaves rgb6 (and the field) untouched.
  const [lastRgb, setLastRgb] = useState(rgb6)
  if (rgb6 !== lastRgb) {
    setLastRgb(rgb6)
    setText(rgb6)
  }

  const commit = (raw: string) => {
    const c = parseHexA(raw) // accepts a pasted #rrggbbaa too — updates the slider
    if (!c) {
      setText(rgb6)
      return
    }
    // A 6-digit hex carries no alpha → keep the swatch's current opacity (only an
    // explicit 8-digit #rrggbbaa changes it). The slider owns alpha otherwise.
    onChange(c.a !== undefined ? c : value.a !== undefined ? { ...c, a: value.a } : c)
  }
  const setAlpha = (na: number) => {
    const base = { r: value.r, g: value.g, b: value.b }
    onChange(na >= 255 ? base : { ...base, a: na })
  }

  return (
    <div
      className="flex items-center gap-1.5"
      onPointerEnter={() => onHighlight?.(rgb6)}
      onPointerLeave={() => onHighlight?.(null)}
    >
      <label className="checkerboard relative h-6 w-6 shrink-0 cursor-pointer overflow-hidden rounded-md border border-line-strong shadow-xs">
        <span className="block h-full w-full" style={{ backgroundColor: rgb6, opacity: a / 255 }} />
        <input
          type="color"
          value={rgb6}
          // Picking a new RGB keeps the entry's current alpha.
          onChange={(e) => {
            const rgb = hexToRgb(e.target.value)
            if (rgb) onChange(value.a !== undefined ? { ...rgb, a: value.a } : rgb)
          }}
          className="absolute inset-0 cursor-pointer opacity-0"
          aria-label="Pick colour"
        />
      </label>
      <input
        className="input w-16 px-1.5 font-mono text-[11px]"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => commit(text)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        }}
        spellCheck={false}
        aria-label="Hex colour"
      />
      <input
        type="range"
        min={0}
        max={255}
        value={a}
        onChange={(e) => setAlpha(Number(e.target.value))}
        className="h-1.5 min-w-0 flex-1 cursor-pointer appearance-none rounded-full bg-line-strong"
        aria-label="Opacity"
        title={`${pct(value.a)}% opacity`}
      />
      <span className="w-7 shrink-0 text-right text-[10px] tabular-nums text-muted">{pct(value.a)}</span>
      <button
        type="button"
        onClick={onRemove}
        disabled={!canRemove}
        aria-label="Remove colour"
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink-2 transition-colors hover:bg-surface-3 hover:text-bad disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-ink-2"
      >
        <X size={13} />
      </button>
    </div>
  )
}
