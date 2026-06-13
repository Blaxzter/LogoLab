// "How it works" — a user-facing teaching overlay that runs the CURRENT uploaded
// image through the structure-first vectorize pipeline WITH THE USER'S CURRENT
// settings, and shows each stage with a plain-language explanation. The analysis
// runs OFF the main thread (the trace worker's 'analyze' job) so opening it never
// freezes the UI, and its stages honour the same options as the real trace (so the
// region count matches the output). Linked from the vectorize view.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Loader2, X } from 'lucide-react'
import { useLogo } from '../../store'
import { getImageData } from '../../lib/image'
import { analyzeImageOffThread, type OffThreadAnalysis } from '../../lib/trace/traceOffThread'
import { labelColor } from '../../lib/trace/stageViz'
import type { VectorizeOptions } from '../../types'

const ANALYZE_DIM = 512

export function PipelineExplainer({ opts, onClose }: { opts: VectorizeOptions; onClose: () => void }) {
  const logo = useLogo()
  const [analysis, setAnalysis] = useState<OffThreadAnalysis | null>(null)
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
    setError(null)
    if (!logo.src) {
      setError('Load an image first.')
      return
    }
    const controller = new AbortController()
    void (async () => {
      try {
        const image = await getImageData(logo.src!, ANALYZE_DIM, logo.isSvg ? logo.svgText : null)
        const result = await analyzeImageOffThread(image, { ...opts, engine: 'crisp' }, controller.signal)
        setAnalysis(result)
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return
        setError(String(e))
      }
    })()
    return () => controller.abort()
  }, [logo.src, logo.isSvg, logo.svgText, optsKey, opts])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="How vectorize works">
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 bg-ink/40 backdrop-blur-sm" />

      <div className="panel animate-in-fade relative z-10 flex max-h-[88vh] w-full max-w-3xl flex-col overflow-hidden">
        <div className="flex items-start justify-between border-b border-line p-5">
          <div>
            <h2 className="text-base font-semibold text-ink">How vectorize works</h2>
            <p className="mt-1 text-sm text-muted">
              Your image, walked through the five stages — with your current settings — that turn pixels into clean,
              editable vector shapes.
            </p>
          </div>
          <button type="button" onClick={onClose} className="btn btn-ghost -mr-1.5 -mt-1.5 h-8 w-8 shrink-0 px-0" title="Close">
            <X size={16} />
          </button>
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
            <Steps logoSrc={logo.src!} a={analysis} opts={opts} />
          )}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------

function Steps({ logoSrc, a, opts }: { logoSrc: string; a: OffThreadAnalysis; opts: VectorizeOptions }) {
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
        }`}
      >
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

      <p className="rounded-md border border-accent-soft bg-accent-soft px-3 py-2 text-xs leading-snug text-ink-2">
        Tip: if overlapping or finely-detailed areas don't come through, it's usually step 3 — those areas merged
        into a neighbouring region before they could become their own shape. Raise <b>Region detail</b> to keep them.
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
