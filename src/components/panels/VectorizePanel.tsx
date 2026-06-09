import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Copy, Download, ImageOff, Wand2 } from 'lucide-react'
import { useLogo } from '../../store'
import { Button } from '../ui/Button'
import { ColorField, Field, Segmented, Slider, Toggle } from '../ui/controls'
import { getImageData } from '../../lib/image'
import { downloadText } from '../../lib/download'
import {
  cleanSvg,
  DEFAULT_CLEAN_OPTIONS,
  type CleanResult,
} from '../../lib/svgClean'
import {
  DEFAULT_VECTORIZE_OPTIONS,
  vectorizeImageData,
} from '../../lib/vectorize'
import type { VectorizeOptions } from '../../types'

const RASTER_MAX_DIM = 512
const DEBOUNCE_MS = 350

/** Human-readable byte size. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 2 : 1)} KB`
  return `${(kb / 1024).toFixed(2)} MB`
}

/** Percentage delta of after vs before (negative = smaller). */
function deltaPct(before: number, after: number): number {
  if (before <= 0) return 0
  return Math.round(((after - before) / before) * 100)
}

export default function VectorizePanel() {
  const logo = useLogo()
  const hasLogo = Boolean(logo.src)
  const isVectorSource = logo.isSvg && Boolean(logo.svgText)

  const [opts, setOpts] = useState<VectorizeOptions>(DEFAULT_VECTORIZE_OPTIONS)
  const [precision, setPrecision] = useState<number>(DEFAULT_CLEAN_OPTIONS.precision)
  const [forceColorOn, setForceColorOn] = useState(false)
  const [forceColor, setForceColor] = useState('#14161c')
  /** For vector sources: clean existing svg (false) vs re-trace raster (true). */
  const [retraceVector, setRetraceVector] = useState(false)

  const [result, setResult] = useState<CleanResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const runIdRef = useRef(0)

  const patch = (p: Partial<VectorizeOptions>) => setOpts((o) => ({ ...o, ...p }))

  const cleanFromExisting = isVectorSource && !retraceVector

  const run = useCallback(async () => {
    if (!logo.src) return
    const runId = ++runIdRef.current
    setBusy(true)
    setError(null)
    try {
      // Yield so the loading state can paint before sync tracing runs.
      await Promise.resolve()

      const effectiveForceFill = forceColorOn ? forceColor : null
      let cleaned: CleanResult

      if (logo.isSvg && logo.svgText && !retraceVector) {
        // Already vector — just clean the existing markup.
        cleaned = cleanSvg(logo.svgText, {
          precision,
          stripDimensions: true,
          forceFill: effectiveForceFill,
          removeBackground: opts.removeBackground,
        })
      } else {
        const imageData = await getImageData(logo.src, RASTER_MAX_DIM, logo.isSvg ? logo.svgText : null)
        if (runId !== runIdRef.current) return
        const svg = vectorizeImageData(imageData, opts)
        cleaned = cleanSvg(svg, {
          precision,
          stripDimensions: true,
          forceFill: effectiveForceFill,
          removeBackground: opts.removeBackground,
        })
      }

      if (runId !== runIdRef.current) return
      setResult(cleaned)
    } catch {
      if (runId === runIdRef.current) {
        setError('Could not vectorize this image. Try a different file or settings.')
        setResult(null)
      }
    } finally {
      if (runId === runIdRef.current) setBusy(false)
    }
  }, [logo.src, logo.isSvg, logo.svgText, opts, precision, forceColorOn, forceColor, retraceVector])

  // Auto re-run (debounced) when inputs change.
  useEffect(() => {
    if (!hasLogo) {
      setResult(null)
      return
    }
    const id = window.setTimeout(() => {
      void run()
    }, DEBOUNCE_MS)
    return () => window.clearTimeout(id)
  }, [hasLogo, run])

  const onCopy = async () => {
    if (!result) return
    try {
      await navigator.clipboard.writeText(result.svg)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      setError('Clipboard copy was blocked by the browser.')
    }
  }

  const onDownload = () => {
    if (!result) return
    const base = (logo.fileName?.replace(/\.[^.]+$/, '') || 'logo').trim() || 'logo'
    downloadText(result.svg, `${base}.svg`, 'image/svg+xml')
  }

  if (!hasLogo) {
    return (
      <div className="mx-auto max-w-5xl p-6">
        <EmptyState />
      </div>
    )
  }

  const before = result?.beforeBytes ?? 0
  const after = result?.afterBytes ?? 0
  const dp = deltaPct(before, after)

  return (
    <div className="mx-auto max-w-5xl p-6 animate-in-fade">
      <header className="mb-5">
        <h1 className="text-xl font-semibold text-ink">Vectorize</h1>
        <p className="mt-1 text-sm text-muted">
          Trace your logo to clean, resolution-independent SVG and tidy the result.
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-[300px_1fr]">
        {/* ----------------------------------------------------- Controls */}
        <aside className="panel flex flex-col gap-5 self-start p-4">
          {cleanFromExisting && (
            <div className="rounded-md border border-accent-soft bg-accent-soft px-3 py-2 text-xs leading-snug text-ink-2">
              Already vector — cleaning the existing SVG. Enable “Re-trace from
              raster” to rebuild paths from pixels instead.
            </div>
          )}

          {isVectorSource && (
            <Field
              label="Source"
              hint="Re-tracing rasterizes the SVG, then rebuilds vector paths."
            >
              <Segmented<'clean' | 'retrace'>
                value={retraceVector ? 'retrace' : 'clean'}
                onChange={(v) => setRetraceVector(v === 'retrace')}
                options={[
                  { value: 'clean', label: 'Clean SVG' },
                  { value: 'retrace', label: 'Re-trace' },
                ]}
              />
            </Field>
          )}

          {!cleanFromExisting && (
            <>
              <Field label="Mode">
                <Segmented<'color' | 'mono'>
                  value={opts.mode}
                  onChange={(v) => patch({ mode: v })}
                  options={[
                    { value: 'color', label: 'Color' },
                    { value: 'mono', label: 'Mono' },
                  ]}
                />
              </Field>

              {opts.mode === 'color' ? (
                <Field label="Colors" hint="How many colors to quantize to.">
                  <Slider
                    value={opts.colors}
                    min={2}
                    max={32}
                    onChange={(v) => patch({ colors: v })}
                  />
                </Field>
              ) : (
                <Field
                  label="Threshold"
                  hint="Pixels darker than this become solid; lighter ones drop out."
                >
                  <Slider
                    value={opts.threshold}
                    min={0}
                    max={255}
                    onChange={(v) => patch({ threshold: v })}
                  />
                </Field>
              )}

              <Field
                label="Simplify"
                hint="Higher values smooth curves and drop fine detail."
              >
                <Slider
                  value={opts.simplify}
                  min={0}
                  max={100}
                  onChange={(v) => patch({ simplify: v })}
                />
              </Field>
            </>
          )}

          <Field label="Remove background">
            <Toggle
              checked={opts.removeBackground}
              onChange={(v) => patch({ removeBackground: v })}
              label="Drop the dominant backplate"
            />
          </Field>

          <Field
            label="Force single color"
            right={
              <Toggle
                checked={forceColorOn}
                onChange={setForceColorOn}
              />
            }
          >
            {forceColorOn ? (
              <ColorField value={forceColor} onChange={setForceColor} />
            ) : (
              <p className="text-xs text-muted leading-snug">
                Recolor every shape to one fill.
              </p>
            )}
          </Field>

          <Field label="Precision" hint="Decimal places kept in path coordinates.">
            <Slider
              value={precision}
              min={0}
              max={3}
              onChange={setPrecision}
            />
          </Field>

          <Button
            variant="primary"
            block
            onClick={() => void run()}
            disabled={busy}
            icon={<Wand2 size={15} />}
          >
            {busy ? 'Tracing…' : cleanFromExisting ? 'Clean SVG' : 'Trace'}
          </Button>
        </aside>

        {/* ------------------------------------------------------- Results */}
        <section className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Preview title="Original">
              <div className="checkerboard flex h-full w-full items-center justify-center">
                <img
                  src={logo.src!}
                  alt={logo.fileName ?? 'original logo'}
                  draggable={false}
                  className="max-h-full max-w-full object-contain"
                  style={{ padding: '8%' }}
                />
              </div>
            </Preview>

            <Preview title="Traced" badge={busy ? 'Working…' : undefined}>
              <div className="checkerboard relative flex h-full w-full items-center justify-center">
                {result && result.svg ? (
                  <div
                    className="flex h-full w-full items-center justify-center [&>svg]:max-h-full [&>svg]:max-w-full"
                    style={{ padding: '8%' }}
                    dangerouslySetInnerHTML={{ __html: result.svg }}
                  />
                ) : (
                  <span className="text-xs text-muted">
                    {error ? 'Failed' : busy ? 'Tracing…' : 'No result yet'}
                  </span>
                )}
                {busy && result && (
                  <span className="absolute inset-0 bg-surface/40 backdrop-blur-[1px]" />
                )}
              </div>
            </Preview>
          </div>

          {error && (
            <div className="rounded-md border border-bad/30 bg-bad/5 px-3 py-2 text-sm text-bad">
              {error}
            </div>
          )}

          {/* Stats */}
          <div className="panel grid grid-cols-2 gap-px overflow-hidden bg-line sm:grid-cols-4">
            <Stat label="Paths" value={result ? String(result.paths) : '—'} />
            <Stat label="Colors" value={result ? String(result.colors) : '—'} />
            <Stat
              label="Before"
              value={result ? formatBytes(before) : '—'}
            />
            <Stat
              label="After"
              value={result ? formatBytes(after) : '—'}
              sub={
                result
                  ? dp <= 0
                    ? `${dp}%`
                    : `+${dp}%`
                  : undefined
              }
              tone={result ? (dp <= 0 ? 'good' : 'warn') : undefined}
            />
          </div>

          {/* Footer actions */}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              onClick={onDownload}
              disabled={!result}
              icon={<Download size={15} />}
            >
              Download SVG
            </Button>
            <Button
              variant="secondary"
              onClick={() => void onCopy()}
              disabled={!result}
              icon={copied ? <Check size={15} /> : <Copy size={15} />}
            >
              {copied ? 'Copied' : 'Copy SVG'}
            </Button>
          </div>
        </section>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------ subcomponents */

function Preview({
  title,
  badge,
  children,
}: {
  title: string
  badge?: string
  children: React.ReactNode
}) {
  return (
    <div className="scene-card flex flex-col">
      <div className="flex items-center justify-between border-b border-line px-3 py-2">
        <span className="field-label">{title}</span>
        {badge && <span className="text-[11px] font-medium text-accent">{badge}</span>}
      </div>
      <div className="aspect-square w-full">{children}</div>
    </div>
  )
}

function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string
  value: string
  sub?: string
  tone?: 'good' | 'warn'
}) {
  const toneClass = tone === 'good' ? 'text-good' : tone === 'warn' ? 'text-warn' : 'text-muted'
  return (
    <div className="flex flex-col gap-0.5 bg-surface px-3 py-3">
      <span className="field-label">{label}</span>
      <span className="font-mono text-sm tabular-nums text-ink">
        {value}
        {sub && <span className={`ml-1.5 text-xs ${toneClass}`}>{sub}</span>}
      </span>
    </div>
  )
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center gap-4 rounded-xl border-2 border-dashed border-line-strong bg-surface-2 px-6 py-20 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-surface-3 text-faint">
        <ImageOff size={26} />
      </div>
      <div>
        <p className="text-base font-medium text-ink">No logo to vectorize</p>
        <p className="mt-1 text-sm text-muted">
          Drop a PNG, JPG, or SVG into the app to trace it to clean vector paths.
        </p>
      </div>
    </div>
  )
}
