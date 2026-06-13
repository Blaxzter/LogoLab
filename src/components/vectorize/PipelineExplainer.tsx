// "How it works" — a user-facing teaching overlay that runs the CURRENT uploaded
// image through the structure-first vectorize pipeline and shows each stage with a
// plain-language explanation. Linked from the vectorize view so people can see the
// approach, not just the result. Reuses the same stage visualizers as the dev
// scoreboard (lib/trace/stageViz) so the pictures match.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Loader2, X } from 'lucide-react'
import { useLogo } from '../../store'
import { getImageData } from '../../lib/image'
import { segmentImage, DEFAULT_SEGMENT_OPTIONS, type SegmentResult } from '../../lib/trace/segment'
import { fitPaintLadder, type PaintLadderResult } from '../../lib/trace/gradient'
import { traceImage, DEFAULT_VECTORIZE_OPTIONS } from '../../lib/trace'
import { serializeDoc, docStats } from '../../lib/path/model'
import {
  smoothedToRgba,
  discontinuityToRgba,
  segmentsToRgba,
  regionFillsToRgba,
  labelColor,
} from '../../lib/trace/stageViz'

const ANALYZE_DIM = 512

interface Analysis {
  width: number
  height: number
  seg: SegmentResult
  paints: PaintLadderResult[]
  svg: string
  stats: { paths: number; nodes: number }
}

export function PipelineExplainer({ onClose }: { onClose: () => void }) {
  const logo = useLogo()
  const [analysis, setAnalysis] = useState<Analysis | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Run the pipeline on the current image once, off the open animation.
  useEffect(() => {
    let cancelled = false
    setAnalysis(null)
    setError(null)
    if (!logo.src) {
      setError('Load an image first.')
      return
    }
    void (async () => {
      try {
        const image = await getImageData(logo.src!, ANALYZE_DIM, logo.isSvg ? logo.svgText : null)
        // Let the spinner paint before the synchronous heavy stages. Use a timer,
        // not requestAnimationFrame — rAF is throttled/paused in background tabs,
        // which would hang the analysis whenever the tab isn't foregrounded.
        await new Promise((r) => setTimeout(r, 16))
        const rgba = image as unknown as { width: number; height: number; data: Uint8ClampedArray }
        const seg = segmentImage(rgba, DEFAULT_SEGMENT_OPTIONS)
        const paints = seg.regionSamples.map((s) => fitPaintLadder(s))
        const doc = await traceImage(image, { ...DEFAULT_VECTORIZE_OPTIONS, engine: 'crisp', gradients: true })
        const st = docStats(doc)
        if (cancelled) return
        setAnalysis({ width: image.width, height: image.height, seg, paints, svg: serializeDoc(doc, 2), stats: { paths: st.paths, nodes: st.nodes } })
      } catch (e) {
        if (!cancelled) setError(String(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [logo.src, logo.isSvg, logo.svgText])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="How vectorize works">
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 bg-ink/40 backdrop-blur-sm" />

      <div className="panel animate-in-fade relative z-10 flex max-h-[88vh] w-full max-w-3xl flex-col overflow-hidden">
        <div className="flex items-start justify-between border-b border-line p-5">
          <div>
            <h2 className="text-base font-semibold text-ink">How vectorize works</h2>
            <p className="mt-1 text-sm text-muted">
              Your image, walked through the five stages that turn pixels into clean, editable vector shapes.
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
            <Steps logoSrc={logo.src!} a={analysis} />
          )}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------

function Steps({ logoSrc, a }: { logoSrc: string; a: Analysis }) {
  const { seg, paints, width, height } = a
  const regionCount = seg.palette.length
  // Distinct paint models actually used, for the step-4 wording.
  const models = paints.map((p) => p?.model ?? 'solid')
  const hasGrad = models.some((m) => m === 'linear' || m === 'radial' || m === 'glow')

  return (
    <div className="flex flex-col gap-6">
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
        control="Smoothing"
        body="First we denoise the image into smooth colour fields (a Mumford–Shah solver) and, as a by-product, get a map of the strong edges between them — the borders worth keeping. Anti-aliasing fuzz and sensor noise are smoothed away so they don't become jagged shapes."
      >
        <Visual label="Smoothed">
          <StageCanvas rgba={smoothedToRgba(seg.ms)} width={width} height={height} />
        </Visual>
        <Visual label="Detected edges">
          <StageCanvas rgba={discontinuityToRgba(seg.ms)} width={width} height={height} />
        </Visual>
      </Step>

      <Step
        n={3}
        title="Group pixels into regions"
        control="Despeckle"
        body={`Pixels belonging to one smooth field are merged into a handful of macro-regions — each will become one shape. Your image became ${regionCount} region${regionCount === 1 ? '' : 's'}. This grouping is the key step: areas that are similar enough get fused, so very subtle differences (like the soft blends where translucent shapes overlap) can merge into a neighbour rather than become their own shape.`}
      >
        <Visual label={`${regionCount} regions`}>
          <StageCanvas rgba={segmentsToRgba(seg.labels, width, height)} width={width} height={height} />
        </Visual>
      </Step>

      <Step
        n={4}
        title="Fit the simplest paint that matches"
        control="Gradients"
        body={`Each region gets the cheapest paint that still fits it well: a flat colour, a smooth gradient, or a layered “glow” stack — whichever reproduces the region with the fewest knobs.${hasGrad ? ' Some of your regions matched a gradient (coloured tags below).' : ' Every region here matched a single flat colour.'}`}
      >
        <Visual label="Region fills">
          <StageCanvas rgba={regionFillsToRgba(seg.labels, seg.palette, width, height)} width={width} height={height} />
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
        control="Engine · Fidelity"
        body={`Finally each region's outline is traced into smooth Bézier curves — with sharp corners kept sharp — and a beautify pass snaps near-circles, near-lines and shared centres to perfect shapes. Result: ${a.stats.paths} path${a.stats.paths === 1 ? '' : 's'}, ${a.stats.nodes} nodes.`}
      >
        <Visual label="Vector result">
          <div className="h-full w-full [&>svg]:h-full [&>svg]:w-full" dangerouslySetInnerHTML={{ __html: a.svg }} />
        </Visual>
      </Step>

      <p className="rounded-md border border-accent-soft bg-accent-soft px-3 py-2 text-xs leading-snug text-ink-2">
        Tip: if overlapping or finely-detailed areas don't come through, it's usually step 3 — those areas merged
        into a neighbouring region before they could become their own shape. The <b>Crisp</b> engine gives the fewest,
        cleanest nodes; <b>Potrace</b> stays closest to the pixels.
      </p>
    </div>
  )
}

function Step({
  n,
  title,
  body,
  control,
  children,
}: {
  n: number
  title: string
  body: string
  /** The trace control that drives this stage, shown as a chip. */
  control?: string
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
          {control && (
            <span className="mt-1 inline-block rounded bg-surface-3 px-1.5 py-0.5 text-[10px] text-ink-2">
              control: {control}
            </span>
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
