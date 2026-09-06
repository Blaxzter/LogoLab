// The icon-sheet rail: how the sheet is split, how the icons are cropped, how
// they are traced, and how they leave. Same control vocabulary as the vectorize
// rail (Field / Slider / Toggle / Segmented / Collapsible) so the two studios
// feel like one app.

import type { ReactNode } from 'react'
import { Loader2, Play, RefreshCw, Square, Trash2, Download } from 'lucide-react'
import { Button } from '../ui/Button'
import { Collapsible, Field, Segmented, Slider, TextField, Toggle } from '../ui/controls'
import { CAPTION_UNSURE_BELOW } from '../../sheetStore'
import type {
  DetectMode,
  GradientMode,
  OcrState,
  SheetDetectSettings,
  SheetIcon,
  SheetNaming,
  SheetSource,
} from '../../sheetStore'
import type { SheetColorMode } from '../../lib/sheet/traceTile'
import { cleanAffix, exportName } from '../../lib/sheet'
import type { SheetGrid } from '../../lib/sheet'
import type { VectorizeOptions } from '../../types'

export interface SheetControlsProps {
  source: SheetSource
  detect: SheetDetectSettings
  onDetect: (patch: Partial<SheetDetectSettings>) => void
  grid: SheetGrid | null
  warnings: string[]
  tiles: SheetIcon[]
  traceOptions: VectorizeOptions
  onTraceOptions: (patch: Partial<VectorizeOptions>) => void
  colorMode: SheetColorMode
  onColorMode: (mode: SheetColorMode) => void
  hiRes: boolean
  onHiRes: (on: boolean) => void
  gradientMode: GradientMode
  onGradientMode: (mode: GradientMode) => void
  naming: SheetNaming
  onNaming: (patch: Partial<SheetNaming>) => void
  ocr: OcrState
  /** Run the caption OCR again after a failure. */
  onRetryCaptions: () => void
  running: boolean
  onTraceAll: () => void
  onTraceStale: () => void
  onStop: () => void
  onSetAllIncluded: (included: boolean) => void
  exportSvg: boolean
  onExportSvg: (v: boolean) => void
  exportPng: boolean
  onExportPng: (v: boolean) => void
  transparentPng: boolean
  onTransparentPng: (v: boolean) => void
  exporting: boolean
  onExport: () => void
  onReplace: () => void
  onClear: () => void
}

export function SheetControls(props: SheetControlsProps) {
  return (
    <aside className="hidden w-[320px] shrink-0 flex-col border-r border-line bg-surface md:flex">
      <SheetControlsBody {...props} />
    </aside>
  )
}

export function SheetControlsBody({
  source,
  detect,
  onDetect,
  grid,
  warnings,
  tiles,
  traceOptions,
  onTraceOptions,
  colorMode,
  onColorMode,
  hiRes,
  onHiRes,
  gradientMode,
  onGradientMode,
  naming,
  onNaming,
  ocr,
  onRetryCaptions,
  running,
  onTraceAll,
  onTraceStale,
  onStop,
  onSetAllIncluded,
  exportSvg,
  onExportSvg,
  exportPng,
  onExportPng,
  transparentPng,
  onTransparentPng,
  exporting,
  onExport,
  onReplace,
  onClear,
}: SheetControlsProps) {
  const icons = tiles.filter((t) => t.included)
  const traced = tiles.filter((t) => t.svg).length
  const stale = tiles.filter((t) => t.stale && t.doc).length
  const exportable = icons.filter((t) => (exportSvg && t.svg) || exportPng).length
  const affix = cleanAffix(naming.prefix) || cleanAffix(naming.suffix)
  const exampleName = icons[0] ? exportName(icons[0].name, naming.prefix, naming.suffix) : null
  // The section is closed by default and the captions are read by default, so
  // the collapsed line is where the run's progress has to show.
  const namesSummary = !naming.fromCaptions
    ? 'numbered'
    : ocr.status === 'loading'
      ? `loading the OCR engine… ${Math.round(ocr.progress * 100)}%`
      : ocr.status === 'reading'
        ? `reading captions ${ocr.done}/${ocr.total}…`
        : ocr.status === 'error'
          ? 'captions could not be read'
          : 'from captions'

  return (
    <>
      <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-ink">Icon sheet</h2>
          <div className="flex items-center gap-1">
            <button type="button" onClick={onReplace} className="btn btn-ghost h-7 px-2 text-xs">
              Replace
            </button>
            <button type="button" onClick={onClear} title="Remove the sheet" className="btn btn-ghost h-7 w-7 px-0">
              <Trash2 size={13} />
            </button>
          </div>
        </div>

        <div className="rounded-md border border-line bg-surface-2 px-3 py-2 text-xs leading-snug text-muted">
          <div className="truncate font-medium text-ink-2">{source.fileName ?? 'sheet'}</div>
          <div className="font-mono tabular-nums">
            {source.width}×{source.height} · {tiles.length} boxes · {icons.length} included
            {traced > 0 ? ` · ${traced} traced` : ''}
          </div>
        </div>

        {/* ------------------------------------------------------------ split */}
        <Field label="Split" hint="Auto reads the icons off the paper; Grid divides the sheet evenly.">
          <Segmented<DetectMode>
            value={detect.mode}
            onChange={(v) => onDetect({ mode: v })}
            options={[
              { value: 'auto', label: 'Auto' },
              { value: 'grid', label: 'Grid' },
            ]}
          />
        </Field>

        {detect.mode === 'auto' ? (
          <Collapsible
            title="Detection"
            summary={`${grid ? `${grid.rows}×${grid.cols} grid` : 'free layout'} · threshold ${detect.threshold}`}
            defaultOpen
          >
            <Field
              label="Ink threshold"
              hint="How far a pixel must differ from the paper colour to count as artwork. Raise it if the paper texture is being picked up."
            >
              <Slider value={detect.threshold} min={4} max={96} onChange={(v) => onDetect({ threshold: v })} />
            </Field>
            <Field
              label="Merge gap"
              hint={
                detect.gap === null
                  ? 'Automatic: the gap that holds each icon together longest as it grows. Override if parts of one icon land in separate boxes.'
                  : 'Pieces closer than this (sheet px) belong to the same icon.'
              }
              right={
                <Toggle
                  checked={detect.gap === null}
                  onChange={(on) => onDetect({ gap: on ? null : 24 })}
                  label="Automatic merge gap"
                />
              }
            >
              {detect.gap !== null && (
                <Slider value={detect.gap} min={1} max={160} onChange={(v) => onDetect({ gap: v })} unit="px" />
              )}
            </Field>
            <Field
              label="Keep caption text"
              hint="Sheets usually label every icon. Captions are detected and set aside; turn this on to get boxes for them too."
              right={<Toggle checked={detect.keepLabels} onChange={(v) => onDetect({ keepLabels: v })} label="Keep caption text" />}
            >
              <></>
            </Field>
          </Collapsible>
        ) : (
          <Collapsible title="Grid" summary={`${detect.rows} × ${detect.cols}`} defaultOpen>
            <Field label="Rows">
              <Slider value={detect.rows} min={1} max={16} onChange={(v) => onDetect({ rows: v })} />
            </Field>
            <Field label="Columns">
              <Slider value={detect.cols} min={1} max={16} onChange={(v) => onDetect({ cols: v })} />
            </Field>
            <Field label="Margin" hint="Border of the sheet to skip before the first cell.">
              <Slider value={detect.margin} min={0} max={Math.round(Math.min(source.width, source.height) / 4)} onChange={(v) => onDetect({ margin: v })} unit="px" />
            </Field>
            <Field label="Gutter" hint="Space between cells.">
              <Slider value={detect.gutter} min={0} max={Math.round(Math.min(source.width, source.height) / 8)} onChange={(v) => onDetect({ gutter: v })} unit="px" />
            </Field>
          </Collapsible>
        )}

        {/* ------------------------------------------------------------- crop */}
        {detect.mode === 'auto' && (
          <Collapsible
            title="Crop"
            summary={`${Math.round(detect.padding * 100)}% padding${detect.square ? ' · square' : ''}${detect.uniform ? ' · uniform' : ''}`}
          >
            <Field label="Padding" hint="Breathing room around the artwork, as a share of the icon's size.">
              <Slider
                value={Math.round(detect.padding * 100)}
                min={0}
                max={40}
                unit="%"
                onChange={(v) => onDetect({ padding: v / 100 })}
              />
            </Field>
            <Field
              label="Square crops"
              hint="What an icon export almost always wants."
              right={<Toggle checked={detect.square} onChange={(v) => onDetect({ square: v })} label="Square crops" />}
            >
              <></>
            </Field>
            <Field
              label="Uniform size"
              hint="Give every icon the same box, so a small glyph stays smaller than a big one instead of being blown up to match."
              right={<Toggle checked={detect.uniform} onChange={(v) => onDetect({ uniform: v })} label="Uniform size" />}
            >
              <></>
            </Field>
          </Collapsible>
        )}

        {/* ------------------------------------------------------------ names */}
        <Collapsible
          title="Names"
          summary={`${namesSummary}${affix ? ` · ${cleanAffix(naming.prefix)}…${cleanAffix(naming.suffix)}` : ''}`}
        >
          <Field
            label="Name from captions"
            hint="Reads the caption under each icon and uses it as the icon's name. The OCR engine (~5 MB) is downloaded the first time a sheet has captions, then cached; the sheet itself never leaves this tab."
            right={
              <Toggle
                checked={naming.fromCaptions}
                onChange={(v) => onNaming({ fromCaptions: v })}
                label="Name from captions"
              />
            }
          >
            {naming.fromCaptions ? <CaptionStatus ocr={ocr} tiles={tiles} onRetry={onRetryCaptions} /> : <></>}
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Prefix">
              <TextField value={naming.prefix} onChange={(v) => onNaming({ prefix: v })} placeholder="ic-" maxLength={40} />
            </Field>
            <Field label="Suffix">
              <TextField value={naming.suffix} onChange={(v) => onNaming({ suffix: v })} placeholder="-24" maxLength={40} />
            </Field>
          </div>
          {exampleName && (
            <p className="-mt-2 truncate font-mono text-[11px] text-muted" title={`${exampleName}.svg`}>
              e.g. {exampleName}.svg
            </p>
          )}
        </Collapsible>

        {/* ------------------------------------------------------------ trace */}
        <Collapsible
          title="Trace defaults"
          summary={`${colorMode === 'auto' ? 'colour auto' : colorMode === 'mono' ? 'Mono' : 'Color'}${
            colorMode === 'mono'
              ? ''
              : ` · ${gradientMode === 'auto' ? 'gradients auto' : gradientMode === 'flat' ? 'flat fills' : 'gradients on'}`
          }`}
          defaultOpen
        >
          <div className="rounded-md border border-line bg-surface-2 px-3 py-2 text-xs leading-snug text-muted">
            Applies to every icon. Open a single icon for the full vectorizer — its own settings, node editing and
            markers.
          </div>
          <Field
            label="Mode"
            hint="Auto counts the colours in each icon: one ink ⇒ mono (one clean shape, in the ink's own colour), more ⇒ colour. Sheet icons are usually one ink whose shading would otherwise split the shapes."
          >
            <Segmented<SheetColorMode>
              value={colorMode}
              onChange={onColorMode}
              options={[
                { value: 'auto', label: 'Auto' },
                { value: 'color', label: 'Color' },
                { value: 'mono', label: 'Mono' },
              ]}
            />
          </Field>
          {colorMode !== 'mono' && (
            <Field label="Gradients" hint="Auto decides per icon from its own pixels — a flat glyph traces flat, a shaded badge doesn't.">
              <Segmented<GradientMode>
                value={gradientMode}
                onChange={onGradientMode}
                options={[
                  { value: 'auto', label: 'Auto' },
                  { value: 'flat', label: 'Flat' },
                  { value: 'rich', label: 'Rich' },
                ]}
              />
            </Field>
          )}
          <Field
            label="Trace enlarged"
            hint="Traces each crop at ~512px instead of its native size. Anti-aliased edges carry sub-pixel detail a small crop's pixel grid cannot use — measured over 54 icons: the traced area matches the source 6× more closely, for ~2.5× the trace time and somewhat more nodes."
            right={<Toggle checked={hiRes} onChange={onHiRes} label="Trace enlarged" />}
          >
            <></>
          </Field>
          <Field
            label="Transparent background"
            hint="Drops the sheet's paper colour from every traced icon."
            right={
              <Toggle
                checked={traceOptions.removeBackground}
                onChange={(v) => onTraceOptions({ removeBackground: v })}
                label="Transparent background"
              />
            }
          >
            <></>
          </Field>
          <Field
            label="Smoothing"
            hint="Low keeps corners crisp; high sweeps out detail. Scaled down per icon: smoothing is an absolute tolerance, and a 170px crop would lose its interior details at the full-size setting."
          >
            <Slider value={traceOptions.smoothing} min={0} max={100} onChange={(v) => onTraceOptions({ smoothing: v })} />
          </Field>
          <Field label="Despeckle" hint="Drops specks and stray anti-aliasing colours.">
            <Slider value={traceOptions.despeckle} min={0} max={100} onChange={(v) => onTraceOptions({ despeckle: v })} />
          </Field>
        </Collapsible>

        {/* ----------------------------------------------------------- export */}
        <Collapsible title="Export" summary={`${exportable} file${exportable === 1 ? '' : 's'} in the zip`}>
          <Field
            label="Traced SVG"
            right={<Toggle checked={exportSvg} onChange={onExportSvg} label="Export traced SVG" />}
            hint="One .svg per traced icon."
          >
            <></>
          </Field>
          <Field
            label="Cropped PNG"
            right={<Toggle checked={exportPng} onChange={onExportPng} label="Export cropped PNG" />}
            hint="The pixels as cut from the sheet — useful even before tracing."
          >
            <></>
          </Field>
          {exportPng && (
            <Field
              label="Knock out background"
              right={<Toggle checked={transparentPng} onChange={onTransparentPng} label="Knock out background" />}
              hint="Floods the paper colour away from the PNG edges."
            >
              <></>
            </Field>
          )}
          <Button
            variant="secondary"
            block
            icon={exporting ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />}
            disabled={exporting || exportable === 0 || (!exportSvg && !exportPng)}
            onClick={onExport}
          >
            {exporting ? 'Zipping…' : 'Download zip'}
          </Button>
        </Collapsible>

        {warnings.length > 0 && (
          <ul className="flex flex-col gap-1 rounded-md border border-line bg-surface-2 px-3 py-2 text-xs leading-snug text-muted">
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        )}

        <div className="flex items-center gap-2 text-xs text-muted">
          <button type="button" onClick={() => onSetAllIncluded(true)} className="btn btn-ghost h-7 px-2 text-xs">
            Include all
          </button>
          <button type="button" onClick={() => onSetAllIncluded(false)} className="btn btn-ghost h-7 px-2 text-xs">
            None
          </button>
        </div>
      </div>

      {/* Pinned action — the batch is the point of this view, so it never scrolls away. */}
      <div className="shrink-0 border-t border-line p-3">
        {running ? (
          <Button variant="secondary" block icon={<Square size={14} />} onClick={onStop}>
            Stop tracing
          </Button>
        ) : (
          <Button variant="primary" block icon={<Play size={15} />} disabled={icons.length === 0} onClick={onTraceAll}>
            {traced > 0 ? `Re-trace ${icons.length} icons` : `Trace ${icons.length} icons`}
          </Button>
        )}
        {!running && stale > 0 && (
          <button type="button" onClick={onTraceStale} className="btn btn-ghost mt-2 h-7 w-full gap-1.5 px-2 text-xs">
            <RefreshCw size={12} />
            Re-trace {stale} out of date
          </button>
        )}
      </div>
    </>
  )
}

/**
 * Where the caption naming stands: the engine coming down, captions being
 * read, or the tally — including how many reads deserve a second look, since a
 * misread caption exports a misnamed file without anyone noticing otherwise.
 */
function CaptionStatus({ ocr, tiles, onRetry }: { ocr: OcrState; tiles: SheetIcon[]; onRetry: () => void }) {
  const icons = tiles.filter((t) => t.kind === 'icon')
  const captioned = icons.filter((t) => t.caption).length
  const unsure = icons.filter(
    (t) => t.caption?.text != null && !t.renamed && (t.caption.confidence ?? 0) < CAPTION_UNSURE_BELOW,
  ).length

  let body: ReactNode
  if (ocr.status === 'loading') {
    body = (
      <>
        <Loader2 size={11} className="shrink-0 animate-spin text-accent" />
        Loading the OCR engine… {Math.round(ocr.progress * 100)}%
      </>
    )
  } else if (ocr.status === 'reading') {
    body = (
      <>
        <Loader2 size={11} className="shrink-0 animate-spin text-accent" />
        Reading captions {ocr.done}/{ocr.total}…
      </>
    )
  } else if (ocr.status === 'error') {
    body = (
      <span className="text-bad">
        {ocr.error ?? 'Reading the captions failed.'}{' '}
        <button type="button" onClick={onRetry} className="underline underline-offset-2">
          Retry
        </button>
      </span>
    )
  } else if (captioned === 0) {
    body = 'No captions were found under the icons on this sheet — names stay numbered.'
  } else {
    body = `${captioned} of ${icons.length} icons have a caption${
      unsure > 0 ? ` · ${unsure} read with low confidence — check ${unsure === 1 ? 'it' : 'them'} in the grid` : ''
    }.`
  }
  return <p className="flex items-center gap-1.5 text-xs leading-snug text-muted">{body}</p>
}
