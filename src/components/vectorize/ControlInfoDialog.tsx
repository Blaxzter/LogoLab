// Per-control teaching dialog: opened from a control's (i) button. Explains one
// vectorize knob in plain language and shows its effect as a before/after spread.
//
// The default spread is PRECOMPUTED at build time (controlPreviews.generated.ts,
// lazy-imported here so it stays out of the initial bundle) on a small example
// crafted to make that knob's effect visible. "Use my image" re-runs the same
// variant set live on the uploaded logo via the trace worker, so the user sees
// the effect on their own artwork. The Engine knob is live-only (Potrace can't
// run headlessly) — it computes both engines in the browser on open.

import { useCallback, useEffect, useRef, useState } from 'react'
import { ImageIcon, Loader2, X } from 'lucide-react'
import { useLogo } from '../../store'
import { getImageData } from '../../lib/image'
import { DEFAULT_VECTORIZE_OPTIONS, traceImage } from '../../lib/trace'
import { canTraceOffThread, traceImageOffThread } from '../../lib/trace/traceOffThread'
import { docStats, serializeDoc } from '../../lib/path/model'
import { usePanZoom, type PanZoom } from '../../hooks/usePanZoom'
import { ZoomSurface } from '../ui/ZoomSurface'
import { ZoomControls } from '../ui/ZoomControls'
import { CONTROL_DOCS_BY_ID } from './controlDocs'
import type { ControlPreview, PreviewVariant } from './controlPreviews.generated'

const LIVE_DIM = 420

type Source = 'example' | 'upload'

const exampleUrl = (file: string) => `${import.meta.env.BASE_URL}examples/${file}`

export function ControlInfoDialog({ controlId, onClose }: { controlId: string; onClose: () => void }) {
  const doc = CONTROL_DOCS_BY_ID[controlId]
  const logo = useLogo()
  const hasUpload = Boolean(logo.src)

  // Precomputed spread (lazy). Null until loaded; liveOnly controls never load it.
  const [preview, setPreview] = useState<ControlPreview | null>(null)

  // Live-on-my-image (and the only path for liveOnly controls). Cached per source.
  const [source, setSource] = useState<Source>(doc?.liveOnly ? 'example' : 'example')
  const [liveBusy, setLiveBusy] = useState(false)
  const [liveError, setLiveError] = useState<string | null>(null)
  const [liveResults, setLiveResults] = useState<PreviewVariant[] | null>(null)
  const liveCache = useRef<Map<Source, PreviewVariant[]>>(new Map())
  const runIdRef = useRef(0)

  // One shared pan/zoom across every compare cell — zoom or pan any of them and
  // they all move together (same box size + one transform), so you inspect the
  // exact same region of input and each result side by side, like the main split.
  const pz = usePanZoom({ maxScale: 24 })

  const panelRef = useRef<HTMLDivElement | null>(null)

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Move focus into the dialog on open and restore it to the trigger on close,
  // so keyboard focus never gets stranded behind the modal.
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    panelRef.current?.focus()
    return () => prev?.focus?.()
  }, [])

  // Lazy-load the precomputed spread for non-liveOnly controls.
  useEffect(() => {
    if (!doc || doc.liveOnly) return
    let alive = true
    void import('./controlPreviews.generated').then((m) => {
      if (alive) setPreview(m.CONTROL_PREVIEWS[controlId] ?? null)
    })
    return () => {
      alive = false
    }
  }, [doc, controlId])

  // Resolve source pixels for a live run: the bundled example, or the upload.
  const sourceImage = useCallback(
    async (src: Source): Promise<ImageData> => {
      if (src === 'upload') {
        if (!logo.src) throw new Error('no upload')
        return getImageData(logo.src, LIVE_DIM, logo.isSvg ? logo.svgText : null)
      }
      // Example source — only ever used for bundled examples (liveOnly = Engine).
      if (doc.example.kind !== 'bundled') throw new Error('example has no browser source')
      return getImageData(exampleUrl(doc.example.file), LIVE_DIM, null)
    },
    [logo.src, logo.isSvg, logo.svgText, doc],
  )

  const runLive = useCallback(
    async (src: Source) => {
      const cached = liveCache.current.get(src)
      if (cached) {
        setLiveResults(cached)
        return
      }
      const runId = ++runIdRef.current
      setLiveBusy(true)
      setLiveError(null)
      try {
        const image = await sourceImage(src)
        const base = { ...DEFAULT_VECTORIZE_OPTIONS, ...doc.baseOpts }
        const out: PreviewVariant[] = []
        for (const v of doc.variants) {
          const opts = { ...base, ...v.patch }
          const traced = await (canTraceOffThread(opts)
            ? traceImageOffThread(image, opts)
            : traceImage(image, opts))
          if (runId !== runIdRef.current) return
          const stats = docStats(traced)
          out.push({ label: v.label, svg: serializeDoc(traced), paths: stats.paths, nodes: stats.nodes })
        }
        if (runId !== runIdRef.current) return
        liveCache.current.set(src, out)
        setLiveResults(out)
      } catch {
        if (runId === runIdRef.current) {
          setLiveError('Could not render a live preview for this image.')
        }
      } finally {
        if (runId === runIdRef.current) setLiveBusy(false)
      }
    },
    [doc, sourceImage],
  )

  // Drive live runs: whenever we need a non-precomputed spread (upload source, or
  // a liveOnly control on either source), (re)compute it.
  useEffect(() => {
    if (!doc) return
    if (source === 'upload' || doc.liveOnly) void runLive(source)
    else setLiveResults(null)
  }, [doc, source, runLive])

  // Snap zoom back to fit whenever the spread changes underneath it.
  useEffect(() => {
    pz.reset()
  }, [controlId, source, pz.reset])

  if (!doc) return null

  const usingLive = source === 'upload' || doc.liveOnly
  const variants: PreviewVariant[] | null = usingLive ? liveResults : preview?.variants ?? null
  const loading = usingLive ? liveBusy : !preview

  // The "input" thumbnail reflecting the current source.
  const inputNode =
    source === 'upload' ? (
      <img src={logo.src ?? undefined} alt="" className="h-full w-full object-contain" />
    ) : doc.example.kind === 'bundled' ? (
      <img src={exampleUrl(doc.example.file)} alt="" className="h-full w-full object-contain" />
    ) : preview?.inputSvg ? (
      <div
        className="h-full w-full [&>svg]:h-full [&>svg]:w-full"
        dangerouslySetInnerHTML={{ __html: preview.inputSvg }}
      />
    ) : (
      <div className="flex h-full w-full items-center justify-center text-muted">
        <ImageIcon size={18} />
      </div>
    )

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`About ${doc.label}`}
    >
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 bg-ink/40 backdrop-blur-sm" />

      <div
        ref={panelRef}
        tabIndex={-1}
        className="panel animate-in-fade relative z-10 flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden focus:outline-none"
      >
        <div className="flex items-start justify-between gap-3 border-b border-line p-5">
          <div>
            <h2 className="text-base font-semibold text-ink">{doc.label}</h2>
            <p className="mt-1 text-sm leading-snug text-muted">{doc.hint}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="btn btn-ghost -mr-1.5 -mt-1.5 h-8 w-8 shrink-0 px-0"
            title="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex flex-col gap-5 overflow-y-auto p-5">
          <p className="text-sm leading-relaxed text-ink-2">{doc.blurb}</p>

          {/* Source toggle + shared zoom for the compare cells. */}
          <div className="flex flex-wrap items-center gap-3">
            {!doc.exampleOnly && (
              <>
                <div className="flex rounded-lg bg-surface-3 p-0.5">
                  <SourceTab active={source === 'example'} onClick={() => setSource('example')}>
                    {doc.liveOnly ? 'Sample logo' : 'Example'}
                  </SourceTab>
                  <SourceTab
                    active={source === 'upload'}
                    disabled={!hasUpload}
                    onClick={() => hasUpload && setSource('upload')}
                  >
                    My image
                  </SourceTab>
                </div>
                {!hasUpload && (
                  <span className="text-xs text-muted">Load a logo to preview on your own image.</span>
                )}
              </>
            )}
            {liveBusy && (
              <span className="flex items-center gap-1.5 text-xs text-accent">
                <Loader2 size={13} className="animate-spin" /> Rendering…
              </span>
            )}
            <div className="ml-auto flex items-center gap-2">
              <span className="hidden text-[11px] text-muted sm:inline">Scroll to zoom · drag to pan</span>
              <ZoomControls pz={pz} />
            </div>
          </div>

          {/* Input → outputs spread (cells flex to fill the width; one synced zoom). */}
          <div className="flex items-start gap-4">
            <PreviewCell pz={pz} primary label="Input">
              {inputNode}
            </PreviewCell>
            <div className="flex self-center items-center text-2xl text-faint">→</div>
            {loading ? (
              <div className="flex h-56 flex-1 items-center justify-center text-muted">
                <Loader2 size={22} className="animate-spin" />
              </div>
            ) : liveError ? (
              <div className="flex h-56 flex-1 items-center justify-center text-sm text-bad">{liveError}</div>
            ) : variants && variants.length > 0 ? (
              variants.map((v) => (
                <PreviewCell key={v.label} pz={pz} label={v.label} caption={`${v.nodes} nodes`}>
                  <div
                    className="h-full w-full [&>svg]:h-full [&>svg]:w-full"
                    dangerouslySetInnerHTML={{ __html: v.svg }}
                  />
                </PreviewCell>
              ))
            ) : (
              <div className="flex h-56 flex-1 items-center justify-center text-sm text-muted">
                No preview available.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function SourceTab({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`h-7 rounded-[7px] px-3 text-xs font-medium transition-all disabled:cursor-not-allowed disabled:opacity-40 ${
        active ? 'bg-surface text-ink shadow-xs' : 'text-muted hover:text-ink-2'
      }`}
    >
      {children}
    </button>
  )
}

function PreviewCell({
  pz,
  primary,
  label,
  caption,
  children,
}: {
  pz: PanZoom
  /** Register this cell as the box the +/- buttons zoom around. */
  primary?: boolean
  label: string
  caption?: string
  children: React.ReactNode
}) {
  return (
    <div className="min-w-0 flex-1">
      <ZoomSurface
        pz={pz}
        primary={primary}
        className="checkerboard aspect-square w-full rounded-lg border border-line bg-surface"
      >
        {children}
      </ZoomSurface>
      <div className="mt-1.5 text-center text-xs font-medium text-ink-2">{label}</div>
      {caption && <div className="text-center text-[10px] tabular-nums text-muted">{caption}</div>}
    </div>
  )
}
