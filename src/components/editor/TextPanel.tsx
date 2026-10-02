// The properties rail's Text section: character and paragraph settings for the
// selected text(s), or for the selection inside the open text.
//
// What it shows follows the editors it copies: with characters selected in an
// open text, their style (a mixed property shows blank); with a bare caret, the
// style the next typed character will get; otherwise the whole text. Features
// and variable axes are read from the FONT, so the list only ever offers what
// the face can actually do.

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { TextData, TextStyle } from '../../lib/path/types'
import {
  addUploadedFont,
  allFonts,
  FONT_ACCEPT,
  fontsVersion,
  loadedFace,
  loadFont,
  subscribeFonts,
  type FontCategory,
} from '../../lib/text/fonts'
import { ActionButton } from '../ui/ActionButton'
import { TipLabel, Tooltip } from '../ui/Tooltip'
import { AlignCenter, AlignLeft, AlignRight, FlipVertical2, Italic, Spline, Upload } from '../ui/icons'
import { NumField, Section } from './Inspector'
import type { TextEditing } from './studio/useTextEditing'

const CATEGORY: Record<FontCategory, string> = {
  sans: 'Sans serif',
  serif: 'Serif',
  display: 'Display',
  script: 'Script',
  mono: 'Monospace',
  yours: 'Your fonts',
}

/** Features a user turns on and off, by tag, with what they do. */
const FEATURE_LABEL: Record<string, string> = {
  liga: 'Ligatures',
  dlig: 'Discretionary ligatures',
  calt: 'Contextual alternates',
  smcp: 'Small caps',
  c2sc: 'Capitals to small caps',
  case: 'Case-sensitive forms',
  onum: 'Old-style figures',
  lnum: 'Lining figures',
  tnum: 'Tabular figures',
  pnum: 'Proportional figures',
  zero: 'Slashed zero',
  frac: 'Fractions',
  sups: 'Superscript',
  subs: 'Subscript',
  ordn: 'Ordinals',
  swsh: 'Swashes',
  salt: 'Stylistic alternates',
  titl: 'Titling',
  hist: 'Historical forms',
}
/** On unless turned off (HarfBuzz's defaults). */
const DEFAULT_ON = new Set(['liga', 'calt', 'clig'])

function featureLabel(tag: string): string | null {
  if (FEATURE_LABEL[tag]) return FEATURE_LABEL[tag]
  const ss = /^ss(\d\d)$/.exec(tag)
  if (ss) return `Stylistic set ${Number(ss[1])}`
  const cv = /^cv(\d\d)$/.exec(tag)
  if (cv) return `Character variant ${Number(cv[1])}`
  return null
}

const AXIS_LABEL: Record<string, string> = { opsz: 'Optical size', wdth: 'Width', slnt: 'Slant', ital: 'Italic' }

const WEIGHT_NAME: [number, string][] = [
  [100, 'Thin'],
  [200, 'Extra light'],
  [300, 'Light'],
  [400, 'Regular'],
  [500, 'Medium'],
  [600, 'Semibold'],
  [700, 'Bold'],
  [800, 'Extra bold'],
  [900, 'Black'],
]
const weightName = (w: number) => WEIGHT_NAME.reduce((a, b) => (Math.abs(b[0] - w) < Math.abs(a[0] - w) ? b : a))[1]

export function TextPanel({
  data,
  text,
  onConvert,
}: {
  /** The text the panel reads from (the open one, or the first selected). */
  data: TextData
  text: TextEditing
  onConvert: () => void
}) {
  useSyncExternalStore(subscribeFonts, fontsVersion)
  const shown = text.shownStyle(data)
  const font = shown.font ?? data.style.font
  const italic = shown.italic ?? false
  const face = loadedFace(font, false)
  useEffect(() => {
    if (!face) void loadFont(font)
  }, [face, font])

  const fileRef = useRef<HTMLInputElement | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)

  const set = (patch: Partial<TextStyle>, live = false) => text.restyle(patch, live)
  const wght = face?.axes.find((a) => a.tag === 'wght') ?? null
  const otherAxes = face?.axes.filter((a) => a.tag !== 'wght' && a.tag !== 'ital') ?? []
  const allFeatures = (face?.features ?? []).filter((t) => featureLabel(t) && t !== 'kern')
  // Stylistic sets and character variants come in dozens; they fold away.
  const variant = (t: string) => /^(ss|cv)\d\d$/.test(t)
  const features = allFeatures.filter((t) => !variant(t))
  const variants = allFeatures.filter(variant)
  const chip = (tag: string) => {
    const v = shown.features?.[tag]
    const on = v === undefined ? DEFAULT_ON.has(tag) : v > 0
    return (
      <ActionButton
        key={tag}
        label={featureLabel(tag)!}
        note={`OpenType feature “${tag}”.`}
        pressed={on}
        onClick={() => set({ features: { [tag]: on ? 0 : 1 } })}
        className={`btn btn-secondary h-6 px-1.5 font-mono text-[0.62rem] ${on ? 'is-active' : ''}`}
      >
        {tag}
      </ActionButton>
    )
  }
  const fonts = allFonts()
  const categories = [...new Set(fonts.map((f) => f.category))]

  return (
    <Section title={text.edit ? 'Text — selection' : 'Text'}>
      <div className="flex flex-col gap-2">
        {/* Family */}
        <div className="flex items-center gap-1">
          <Tooltip label={<TipLabel title="Font" detail="Bundled open-source fonts, plus any you upload." />}>
            <select
              aria-label="Font"
              value={shown.font ?? ''}
              onChange={(e) => {
                if (e.target.value) set({ font: e.target.value })
              }}
              className="input h-8 min-w-0 flex-1 text-xs"
            >
              {!shown.font && <option value="">Mixed</option>}
              {categories.map((c) => (
                <optgroup key={c} label={CATEGORY[c]}>
                  {fonts
                    .filter((f) => f.category === c)
                    .map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.family}
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
          </Tooltip>
          <ActionButton
            label="Upload a font"
            note="A .ttf, .otf or .woff file. It stays in this browser and appears under Your fonts."
            onClick={() => fileRef.current?.click()}
            className="btn btn-secondary h-8 w-8 shrink-0 px-0"
          >
            <Upload size={13} />
          </ActionButton>
          <input
            ref={fileRef}
            type="file"
            accept={FONT_ACCEPT}
            className="hidden"
            onChange={async (e) => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (!file) return
              const res = await addUploadedFont(file)
              if ('error' in res) setUploadError(res.error)
              else {
                setUploadError(null)
                set({ font: res.id })
              }
            }}
          />
        </div>
        {uploadError && <p className="text-[0.7rem] text-red-600 dark:text-red-400">{uploadError}</p>}

        {/* Weight + italic */}
        <div className="flex items-center gap-1.5">
          <span className="w-8 shrink-0 text-[0.7rem] text-muted">Weight</span>
          {wght ? (
            <Tooltip label={<TipLabel title="Weight" detail="This font is variable: any weight in its range." />}>
              <input
                type="range"
                aria-label="Weight"
                min={wght.min}
                max={wght.max}
                step={1}
                value={shown.weight ?? wght.default}
                onChange={(e) => set({ weight: Number(e.target.value) }, true)}
                className="min-w-0 flex-1 accent-[var(--color-accent)]"
              />
            </Tooltip>
          ) : (
            <span className="min-w-0 flex-1 text-[0.7rem] text-faint">
              {face ? 'One weight in this font' : 'Loading font…'}
            </span>
          )}
          <span className="w-16 shrink-0 truncate text-right text-[0.7rem] text-muted">
            {wght ? (shown.weight !== undefined ? weightName(shown.weight) : 'Mixed') : ''}
          </span>
          <ActionButton
            label="Italic (Ctrl+I)"
            note="The family's italic where it has one, otherwise a 12° slant."
            pressed={italic}
            onClick={() => set({ italic: !italic })}
            className={`btn btn-secondary h-8 w-8 shrink-0 px-0 ${italic ? 'is-active' : ''}`}
          >
            <Italic size={13} />
          </ActionButton>
        </div>

        <div className="grid grid-cols-2 gap-1.5">
          <NumField
            label="Size"
            value={shown.size ?? data.style.size}
            min={0.1}
            onCommit={(v) => set({ size: v })}
            tip="Em size, in artboard units."
          />
          <NumField
            label="Track"
            value={shown.tracking ?? 0}
            onCommit={(v) => set({ tracking: v })}
            tip="Letter spacing in thousandths of an em. Negative tightens."
          />
          <NumField
            label="Lead"
            value={data.lineHeight}
            min={0.1}
            onCommit={(v) => text.setProps({ lineHeight: v })}
            tip="Line spacing, as a multiple of the size."
          />
          <NumField
            label="Shift"
            value={shown.baselineShift ?? 0}
            onCommit={(v) => set({ baselineShift: v })}
            tip="Baseline shift: raises (positive) or lowers the selected characters."
          />
        </div>

        {/* Paragraph */}
        <div className="flex items-center gap-1">
          {(
            [
              ['left', 'Align left', <AlignLeft key="l" size={13} />],
              ['center', 'Centre', <AlignCenter key="c" size={13} />],
              ['right', 'Align right', <AlignRight key="r" size={13} />],
            ] as const
          ).map(([id, label, icon]) => (
            <ActionButton
              key={id}
              label={label}
              note="Lines line up on the point where you clicked to start the text."
              pressed={data.align === id}
              onClick={() => text.setProps({ align: id })}
              className={`btn btn-secondary h-7 w-8 px-0 ${data.align === id ? 'is-active' : ''}`}
            >
              {icon}
            </ActionButton>
          ))}
          <ActionButton
            label={data.kerning ? 'Kerning on' : 'Kerning off'}
            note="Pair kerning from the font: AV, To and the like tuck together."
            pressed={data.kerning}
            onClick={() => text.setProps({ kerning: !data.kerning })}
            className={`btn btn-secondary ml-auto h-7 px-2 text-[0.7rem] ${data.kerning ? 'is-active' : ''}`}
          >
            Kerning
          </ActionButton>
        </div>

        {/* Variable axes */}
        {otherAxes.map((a) => (
          <label key={a.tag} className="flex items-center gap-1.5">
            <span className="w-16 shrink-0 truncate text-[0.7rem] text-muted">{AXIS_LABEL[a.tag] ?? a.tag}</span>
            <Tooltip label={<TipLabel title={AXIS_LABEL[a.tag] ?? `Axis ${a.tag}`} detail="A variable-font axis." />}>
              <input
                type="range"
                aria-label={AXIS_LABEL[a.tag] ?? a.tag}
                min={a.min}
                max={a.max}
                step={(a.max - a.min) / 100}
                value={shown.variations?.[a.tag] ?? a.default}
                onChange={(e) => set({ variations: { [a.tag]: Number(e.target.value) } }, true)}
                className="min-w-0 flex-1 accent-[var(--color-accent)]"
              />
            </Tooltip>
            <span className="w-9 shrink-0 text-right text-[0.7rem] tabular-nums text-muted">
              {Math.round(shown.variations?.[a.tag] ?? a.default)}
            </span>
          </label>
        ))}

        {/* OpenType features */}
        {allFeatures.length > 0 && (
          <div>
            <span className="mb-1 block text-[0.7rem] text-muted">OpenType</span>
            <div className="flex flex-wrap gap-1">{features.map(chip)}</div>
            {variants.length > 0 && (
              <details className="mt-1.5">
                <summary className="cursor-pointer text-[0.7rem] text-muted hover:text-ink">
                  Stylistic sets &amp; variants ({variants.filter((t) => (shown.features?.[t] ?? 0) > 0).length}/
                  {variants.length})
                </summary>
                <div className="mt-1 flex flex-wrap gap-1">{variants.map(chip)}</div>
              </details>
            )}
          </div>
        )}

        {/* On a path */}
        {data.onPath && (
          <div className="flex items-center gap-1.5">
            <span className="w-8 shrink-0 text-[0.7rem] text-muted">Start</span>
            <Tooltip label={<TipLabel title="Start on path" detail="Slides the text along its curve." />}>
              <input
                type="range"
                aria-label="Start on path"
                min={0}
                max={1}
                step={0.005}
                value={data.onPath.start}
                onChange={(e) => text.setProps({ onPath: { ...data.onPath!, start: Number(e.target.value) } }, true)}
                className="min-w-0 flex-1 accent-[var(--color-accent)]"
              />
            </Tooltip>
            <ActionButton
              label="Other side"
              note="Runs the text along the other side of the curve (inside a circle instead of out)."
              onClick={() => text.setProps({ onPath: { ...data.onPath!, flip: !data.onPath!.flip } })}
              className="btn btn-secondary h-7 w-8 px-0"
            >
              <FlipVertical2 size={13} />
            </ActionButton>
          </div>
        )}

        <ActionButton
          label="Convert to curves"
          note="Turns the text into plain shapes you can node-edit. The words can't be edited after this (Ctrl+Z undoes it)."
          onClick={onConvert}
          className="btn btn-secondary h-7 gap-1.5 text-[0.7rem]"
        >
          <Spline size={13} />
          Convert to curves
        </ActionButton>
      </div>
    </Section>
  )
}
