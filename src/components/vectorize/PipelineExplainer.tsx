// "How it works" — a user-facing teaching overlay that runs the CURRENT uploaded
// image through the structure-first vectorize pipeline WITH THE USER'S CURRENT
// settings, and shows each stage with a plain-language explanation. The analysis
// runs OFF the main thread (the trace worker's 'analyze' job) so opening it never
// freezes the UI, and its stages honour the same options as the real trace (so the
// region count matches the output). Linked from the vectorize view.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Loader2, X } from 'lucide-react'
import { useLogo } from '../../store'
import { Tooltip } from '../ui/Tooltip'
import { getImageData } from '../../lib/image'
import { analyzeImageOffThread, type OffThreadAnalysis } from '../../lib/trace/traceOffThread'
import { labelColor } from '../../lib/trace/stageViz'
import { analyzeRampiness, type RampinessReport } from '../../lib/trace'
import type { VectorizeOptions } from '../../types'

const ANALYZE_DIM = 512

export function PipelineExplainer({
  opts,
  onClose,
  source,
}: {
  opts: VectorizeOptions
  onClose: () => void
  /** The image to explain. Defaults to the app's working logo. */
  source?: { src: string | null; isSvg: boolean; svgText: string | null }
}) {
  const storeLogo = useLogo()
  const logo = source ?? storeLogo
  const [analysis, setAnalysis] = useState<OffThreadAnalysis | null>(null)
  // Gradient-detection probe (rampiness + colour histogram), computed on the main
  // thread from the same decoded image — it's what auto-defaults the toggle.
  const [detect, setDetect] = useState<{ ramp: RampinessReport; hist: ColorHistogram } | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Analyse the current image with the current settings, OFF the main thread.
  const optsKey = JSON.stringify(opts)
  useEffect(() => {
    setAnalysis(null)
    setDetect(null)
    setError(null)
    if (!logo.src) {
      setError('Load an image first.')
      return
    }
    const controller = new AbortController()
    void (async () => {
      try {
        const image = await getImageData(logo.src!, ANALYZE_DIM, logo.isSvg ? logo.svgText : null)
        // Cheap + pure — the same probe that seeds the gradients toggle on load.
        setDetect({ ramp: analyzeRampiness(image), hist: colorHistogram(image) })
        const result = await analyzeImageOffThread(image, { ...opts, engine: 'crisp' }, controller.signal)
        setAnalysis(result)
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return
        setError(String(e))
      }
    })()
    return () => controller.abort()
  }, [logo.src, logo.isSvg, logo.svgText, optsKey, opts])

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="How vectorize works">
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 bg-ink/40 backdrop-blur-sm dark:bg-black/55" />

      <div className="panel animate-in-fade relative z-10 flex max-h-[88vh] w-full max-w-3xl flex-col overflow-hidden">
        <div className="flex items-start justify-between border-b border-line p-5">
          <div>
            <h2 className="text-base font-semibold text-ink">How vectorize works</h2>
            <p className="mt-1 text-sm text-muted">
              Your image, walked through the stages — with your current settings — that turn pixels into clean,
              editable vector shapes.
            </p>
          </div>
          <Tooltip label="Close">
            <button type="button" onClick={onClose} aria-label="Close" className="btn btn-ghost -mr-1.5 -mt-1.5 h-8 w-8 shrink-0 px-0">
              <X size={16} />
            </button>
          </Tooltip>
        </div>

        <div className="overflow-y-auto p-5">
          {error ? (
            <p className="text-sm text-muted">{error}</p>
          ) : !analysis ? (
            <div className="flex flex-col items-center gap-3 py-16 text-sm text-muted">
              <Loader2 size={22} className="animate-spin text-accent" />
              Analyzing your image…
            </div>
          ) : (
            <Steps logoSrc={logo.src!} a={analysis} opts={opts} detect={detect} />
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}

// ---------------------------------------------------------------------------

function Steps({
  logoSrc,
  a,
  opts,
  detect,
}: {
  logoSrc: string
  a: OffThreadAnalysis
  opts: VectorizeOptions
  detect: { ramp: RampinessReport; hist: ColorHistogram } | null
}) {
  const { width, height, regionCount, paints } = a
  const gradientsOn = opts.gradients !== false
  const engineLabel = opts.engine === 'potrace' ? 'Potrace' : 'Crisp'
  const fidelity = opts.fidelity ?? 1.5
  const markerCount = opts.markers?.length ?? 0

  return (
    <div className="flex flex-col gap-6">
      {opts.mode === 'mono' && (
        <p className="rounded-md border border-warn/30 bg-warn/10 px-3 py-2 text-xs leading-snug text-ink-2">
          You're in <b>Mono</b> mode — it simply thresholds the image to one black shape. The colour-grouping stages
          below show how <b>Color</b> mode works; your actual result in step 5 is the mono shape.
        </p>
      )}

      <Step
        n={1}
        title="Start from pixels"
        body={`We rasterize your image to ${width}×${height}px and work from those pixels. Vectorizing means rebuilding it from a few flat/gradient shapes instead of a grid of dots.`}
      >
        <Visual label="Your image">
          <img src={logoSrc} alt="" className="h-full w-full object-contain" />
        </Visual>
      </Step>

      <Step
        n={2}
        title="Smooth, and find the real edges"
        controls={['automatic']}
        body="First we denoise the image into smooth colour fields (a Mumford–Shah solver) and, as a by-product, get a map of the strong edges between them — the borders worth keeping. Anti-aliasing fuzz and sensor noise are smoothed away so they don't become jagged shapes. (This stage runs the same way every time — no knob.)"
      >
        <Visual label="Smoothed">
          <StageCanvas rgba={a.smoothed} width={width} height={height} />
        </Visual>
        <Visual label="Detected edges">
          <StageCanvas rgba={a.disc} width={width} height={height} />
        </Visual>
      </Step>

      <Step
        n={3}
        title="Group pixels into regions"
        controls={[
          `Region detail: ${(opts.regionDetail ?? 0) === 0 ? 'auto' : opts.regionDetail}`,
          ...(markerCount > 0 ? [`Markers: ${markerCount}`] : []),
        ]}
        body={`Pixels belonging to one smooth field are merged into a handful of macro-regions — each will become one shape. With your current settings your image became ${regionCount} region${regionCount === 1 ? '' : 's'}. The Region detail control tunes this merge: at the default, areas similar enough get fused — so subtle differences, like the soft blends where translucent shapes overlap, can merge into a neighbour instead of becoming their own shape. Raise it to keep those finer regions (at the cost of possibly fragmenting smooth gradients into flat bands).${
          markerCount > 0
            ? ` You've placed ${markerCount} region marker${markerCount === 1 ? '' : 's'} — each one is kept as its own region (two differently-marked spots never merge), a surgical way to protect just those areas without raising Region detail everywhere.`
            : ''
        }`}
      >
        <Visual label={`${regionCount} regions`}>
          <StageCanvas rgba={a.segs} width={width} height={height} />
        </Visual>
      </Step>

      <Step
        n={4}
        title="Fit the simplest paint that matches"
        controls={[`Gradients: ${gradientsOn ? 'on' : 'off'}`]}
        body={`Each region gets the cheapest paint that still fits it well: a flat colour, a smooth gradient, or a layered “glow” stack — whichever reproduces the region with the fewest knobs.${
          gradientsOn
            ? ' (Coloured tags below show what each region matched.)'
            : ' Gradients are off, so every region here is a single flat colour.'
        }${
          markerCount > 0
            ? ' Where you’ve marked overlapping translucent shapes, the recovered exclusive + overlap regions are checked against a stack of see-through shapes (a few circles at one opacity over the background): if that stack reproduces the colours better than the opaque pieces, it replaces them — so 3 overlapping translucent circles come out as 3 editable see-through circles, not 7 opaque puzzle-pieces.'
            : ''
        }`}
      >
        {detect && <GradientDetection ramp={detect.ramp} hist={detect.hist} gradientsOn={gradientsOn} />}
        <Visual label="Region fills">
          <StageCanvas rgba={a.fills} width={width} height={height} />
        </Visual>
        <div className="min-w-0 flex-1">
          <div className="mb-1 text-[11px] text-muted">Paint per region</div>
          <div className="flex max-h-[148px] flex-wrap content-start gap-1.5 overflow-y-auto">
            {paints.map((p, i) => {
              const [r, g, b] = labelColor(i)
              const model = p?.model ?? 'solid'
              const [sr, sg, sb] = p?.solid ?? [200, 200, 200]
              return (
                <span key={i} className="flex items-center gap-1 rounded-md border border-line bg-surface-2 px-1.5 py-0.5 text-[10px] text-ink-2">
                  <span className="h-3 w-3 rounded-sm" style={{ background: rgb(sr, sg, sb), outline: `1px solid ${rgb(r, g, b)}` }} />
                  {model}
                </span>
              )
            })}
          </div>
        </div>
      </Step>

      <Step
        n={5}
        title="Trace clean outlines, then tidy them"
        controls={[`Engine: ${engineLabel}`, `Smoothing ${opts.smoothing}`, `Despeckle ${opts.despeckle}`, `Fidelity ${fidelity}px`]}
        body={`Finally each region's outline is traced into smooth Bézier curves — with sharp corners kept sharp — and a beautify pass (Fidelity) snaps near-circles, near-lines and shared centres to perfect shapes. The Engine control chooses how the outline is drawn: Crisp (the default) gives the fewest, cleanest nodes; Potrace sticks closest to the original pixels. Result with your settings: ${a.stats.paths} path${a.stats.paths === 1 ? '' : 's'}, ${a.stats.nodes} nodes.`}
      >
        <Visual label="Vector result">
          <div className="h-full w-full [&>svg]:h-full [&>svg]:w-full" dangerouslySetInnerHTML={{ __html: a.svg }} />
        </Visual>
      </Step>

      <Step
        n={6}
        title="Keep peaks sharp, heal the seams"
        controls={['Planar engine', 'automatic']}
        body="The default Planar engine traces every shared boundary once — so neighbouring shapes meet exactly, with no seam or overlap — then does two finishing touches. Sharp features (a mountain's peak, a V-valley, a frame corner) are found on the raw outline and snapped to their exact sub-pixel point, so they stay crisp instead of being rounded into a soft bevel. And where two colours meet through a soft, blurry edge, stray boundary pixels whose colour clearly belongs to one side are healed back to it — so a continuous stroke doesn't pick up a thin background notch at the junction. Both run automatically (no knob)."
      >
        <Visual label="Before">
          <CornerIllustration variant="before" />
        </Visual>
        <Visual label="After (peaks healed)">
          <CornerIllustration variant="after" />
        </Visual>
      </Step>

      <p className="rounded-md border border-accent-soft bg-accent-soft px-3 py-2 text-xs leading-snug text-ink-2">
        Tip: if overlapping or finely-detailed areas don't come through, it's usually step 3 — those areas merged
        into a neighbouring region before they could become their own shape. Raise <b>Region detail</b> or place
        <b> Mark</b> seeds to keep them; once the overlaps survive, step 4 can rebuild see-through shapes as editable
        translucent layers.
      </p>

      <References />
    </div>
  )
}

/** Links to the algorithms the two engines are built on. */
function References() {
  return (
    <div className="border-t border-line pt-4 text-xs leading-relaxed text-ink-2">
      <div className="mb-1 font-semibold text-ink">The research behind it</div>
      <ul className="flex flex-col gap-1">
        <li>
          The structure-first pipeline and the <b>Crisp</b> engine follow Adobe's{' '}
          <ResearchLink href="https://research.adobe.com/publication/image-vectorization-via-gradient-reconstruction/">
            Image Vectorization via Gradient Reconstruction
          </ResearchLink>{' '}
          (Eurographics 2025), with Schneider's classic Bézier curve fitting (Graphics Gems) at its core.
        </li>
        <li>
          The <b>Potrace</b> engine is Peter Selinger's{' '}
          <ResearchLink href="https://potrace.sourceforge.net/">Potrace</ResearchLink> polygon-tracing algorithm.
        </li>
      </ul>
    </div>
  )
}

function ResearchLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className="text-accent underline underline-offset-2 hover:text-accent-hover">
      {children}
    </a>
  )
}

// --- gradient detection (rampiness + colour histogram) ----------------------

interface ColorHistogram {
  /** Per-channel counts over `bins` value buckets (0–255 split into `bins`). */
  r: number[]
  g: number[]
  b: number[]
  bins: number
  /** Tallest bucket across all channels (for normalising the chart). */
  max: number
}

/** Per-channel RGB histogram over the opaque pixels (the chart only; the palette
 *  stats that feed the decision come from `analyzeRampiness`). */
function colorHistogram(img: ImageData, bins = 64): ColorHistogram {
  const { data } = img
  const r = new Array<number>(bins).fill(0)
  const g = new Array<number>(bins).fill(0)
  const b = new Array<number>(bins).fill(0)
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue
    r[(data[i] * bins) >> 8]++
    g[(data[i + 1] * bins) >> 8]++
    b[(data[i + 2] * bins) >> 8]++
  }
  let max = 1
  for (let k = 0; k < bins; k++) max = Math.max(max, r[k], g[k], b[k])
  return { r, g, b, bins, max }
}

/** The auto-gradients decision, made visible. Gradients turn ON only when BOTH a
 *  gentle slope is present AND the palette is spread — so a flat logo with soft
 *  (anti-aliased) edges, which reads "rampy" but is a few dominant colours, stays
 *  OFF. Both signals are shown with their verdicts so a surprising call is legible. */
function GradientDetection({
  ramp,
  hist,
  gradientsOn,
}: {
  ramp: RampinessReport
  hist: ColorHistogram
  gradientsOn: boolean
}) {
  const pct = ramp.rampiness * 100
  const thrPct = ramp.threshold * 100
  const coverPct = Math.round(ramp.topCoverage * 100)
  const coverMaxPct = Math.round(ramp.coverageMax * 100)
  const verdict = ramp.suggestion ? 'gradients ON' : 'flat → gradients OFF'
  const overridden = gradientsOn !== ramp.suggestion
  return (
    <div className="w-full rounded-lg border border-line bg-surface-2 p-3">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold text-ink">Smooth-gradient detection</span>
        <span
          className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${
            ramp.suggestion ? 'bg-accent-soft text-accent' : 'bg-surface-3 text-ink-2'
          }`}
        >
          {verdict}
        </span>
      </div>
      <p className="mb-2 text-[10px] leading-snug text-muted">
        On only if the colours change gradually <b className="text-ink-2">and</b> the palette is genuinely spread — so
        flat art with soft edges (rampy, but few colours) stays off.
      </p>
      <div className="flex flex-wrap gap-x-5 gap-y-3">
        <div className="min-w-[180px] flex-1">
          <HistogramChart hist={hist} />
          <div className="mt-1 text-[10px] leading-snug text-muted">
            Colour histogram (R/G/B, log scale). <Signal ok={ramp.paletteSpread} />{' '}
            <b className="text-ink-2">{ramp.distinctColors}</b> main colour{ramp.distinctColors === 1 ? '' : 's'}, top 8
            cover <b className="text-ink-2">{coverPct}%</b> ({ramp.paletteSpread ? `spread, ≤${coverMaxPct}%` : `concentrated, >${coverMaxPct}% ⇒ flat`}).
          </div>
        </div>
        <div className="min-w-[180px] flex-1">
          <div className="relative h-3 w-full overflow-hidden rounded bg-surface-3" title="ramp fraction vs threshold">
            <div
              className={`h-full rounded ${ramp.slopePresent ? 'bg-accent' : 'bg-ink/30'}`}
              style={{ width: `${Math.min(100, Math.max(pct, pct > 0 ? 1 : 0))}%` }}
            />
            <div className="absolute inset-y-0 w-0.5 bg-ink/70" style={{ left: `${thrPct}%` }} title={`threshold ${thrPct}%`} />
          </div>
          <div className="mt-1 text-[10px] leading-snug text-muted">
            <Signal ok={ramp.slopePresent} /> <b className="text-ink-2">Rampiness {pct.toFixed(1)}%</b> of the interior
            shows a gentle slope ({ramp.slopePresent ? `≥${thrPct}%` : `below ${thrPct}%`}).{' '}
            {ramp.ramp.toLocaleString()} ramp vs {ramp.flat.toLocaleString()} flat px; {ramp.edge.toLocaleString()}{' '}
            hard-edge px excluded.
          </div>
          {overridden && (
            <div className="mt-1 text-[10px] leading-snug text-warn">
              Active: gradients {gradientsOn ? 'on' : 'off'} — detection suggested {ramp.suggestion ? 'on' : 'off'} (set
              by hand, or the default for an SVG you’re cleaning rather than tracing).
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/** Tiny ✓ / ✗ chip telling whether one signal points at "gradient". */
function Signal({ ok }: { ok: boolean }) {
  return (
    <span className={ok ? 'font-semibold text-accent' : 'font-semibold text-muted'}>{ok ? '✓' : '✗'}</span>
  )
}

/** Three overlaid per-channel area plots — the classic RGB colour histogram, on a
 *  LOG scale so a dominant colour (e.g. a black background) doesn't flatten every
 *  other peak into the baseline. */
function HistogramChart({ hist }: { hist: ColorHistogram }) {
  const { r, g, b, bins, max } = hist
  const W = 200
  const H = 56
  const norm = Math.log1p(max)
  const area = (arr: number[]): string => {
    const step = W / (bins - 1)
    let d = `M0 ${H}`
    for (let k = 0; k < bins; k++) {
      const y = H - (Math.log1p(arr[k]) / norm) * H
      d += ` L${(k * step).toFixed(1)} ${y.toFixed(1)}`
    }
    return `${d} L${W} ${H} Z`
  }
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-14 w-full rounded border border-line bg-surface" preserveAspectRatio="none">
      <path d={area(r)} fill="rgb(239,68,68)" fillOpacity="0.45" />
      <path d={area(g)} fill="rgb(34,197,94)" fillOpacity="0.45" />
      <path d={area(b)} fill="rgb(59,130,246)" fillOpacity="0.45" />
    </svg>
  )
}

function Step({
  n,
  title,
  body,
  controls,
  children,
}: {
  n: number
  title: string
  body: string
  /** Trace controls that drive this stage, shown as chips ('automatic' = no knob). */
  controls?: string[]
  children: ReactNode
}) {
  return (
    <section className="flex flex-col gap-3 sm:flex-row sm:gap-4">
      <div className="flex shrink-0 items-start gap-2 sm:w-52">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent text-[11px] font-semibold text-accent-fg">
          {n}
        </span>
        <div>
          <h3 className="text-sm font-semibold text-ink">{title}</h3>
          {controls && controls.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {controls.map((c) => (
                <span key={c} className="inline-block rounded bg-surface-3 px-1.5 py-0.5 text-[10px] text-ink-2">
                  {c}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="min-w-0 flex-1">
        <p className="mb-3 text-xs leading-relaxed text-ink-2">{body}</p>
        <div className="flex flex-wrap items-start gap-3">{children}</div>
      </div>
    </section>
  )
}

/** A static before/after of the Planar engine's finishing pass: rounded peaks + a
 *  thin background notch at a seam (before) vs sharp peaks + a clean seam (after). */
function CornerIllustration({ variant }: { variant: 'before' | 'after' }) {
  return (
    <svg viewBox="0 0 144 144" className="h-full w-full">
      {variant === 'after' ? (
        <path d="M18 122 L52 42 L80 90 L102 54 L126 122 Z" fill="#f59e0b" />
      ) : (
        <path
          fillRule="evenodd"
          d="M18 122 L42 56 Q52 38 62 56 L74 80 Q80 96 86 80 L93 66 Q102 48 111 66 L126 122 Z M96 122 L104 98 L112 122 Z"
          fill="#f59e0b"
        />
      )}
    </svg>
  )
}

function Visual({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="w-36">
      <div className="checkerboard h-36 w-36 overflow-hidden rounded-lg border border-line bg-surface">{children}</div>
      <div className="mt-1 text-center text-[10px] text-muted">{label}</div>
    </div>
  )
}

/** Draw an RGBA buffer into a canvas that scales to fit its box. */
function StageCanvas({ rgba, width, height }: { rgba: Uint8ClampedArray; width: number; height: number }) {
  const ref = useRef<HTMLCanvasElement | null>(null)
  useEffect(() => {
    const cv = ref.current
    if (!cv) return
    cv.width = width
    cv.height = height
    const ctx = cv.getContext('2d')
    if (!ctx) return
    const id = ctx.createImageData(width, height)
    id.data.set(rgba)
    ctx.putImageData(id, 0, 0)
  }, [rgba, width, height])
  return <canvas ref={ref} className="h-full w-full object-contain" />
}

const rgb = (r: number, g: number, b: number) => `rgb(${r},${g},${b})`
