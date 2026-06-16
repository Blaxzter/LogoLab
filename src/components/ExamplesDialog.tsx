import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Loader2, Shapes, X } from 'lucide-react'
import { useStore } from '../store'
import { loadLogoFile, prefersDarkChecker } from '../lib/image'
import { Tooltip } from './ui/Tooltip'

interface Example {
  /** File under public/examples/. */
  file: string
  name: string
  /** One-liner: which part of LogoLab this one is good for showing off. */
  blurb: string
}

const EXAMPLES: Example[] = [
  { file: 'aurora.svg', name: 'Aurora', blurb: 'Gradient app icon — preview & export an icon set.' },
  { file: 'nebula.png', name: 'Nebula', blurb: 'Gradient-background PNG — the AI cutout’s specialty.' },
  { file: 'orbit.svg', name: 'Orbit', blurb: 'Solid background — Cleanup / By-color, holes and all.' },
  { file: 'petals.png', name: 'Petals', blurb: 'Solid-background PNG — Auto-remove + Vectorize.' },
  { file: 'outline.svg', name: 'Outline', blurb: 'White line-art — see the Background card fix.' },
  { file: 'summit.svg', name: 'Summit', blurb: 'Monochrome mark — try Recolor & Invert.' },
  { file: 'bloom.svg', name: 'Bloom', blurb: 'Multi-color shapes — great for Vectorize.' },
]

const fileFormat = (file: string) => (file.toLowerCase().endsWith('.svg') ? 'SVG' : 'PNG')

const exampleUrl = (file: string) => `${import.meta.env.BASE_URL}examples/${file}`

/** Sidebar entry point: a button that opens a gallery of ready-made logos. */
export function TryExampleButton() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="btn btn-secondary w-full"
      >
        <Shapes size={15} />
        Try an example logo
      </button>
      {open && <ExamplesDialog onClose={() => setOpen(false)} />}
    </>
  )
}

/**
 * Reusable gallery of the bundled example logos. Clicking a card loads it into
 * the store. Used both inside {@link ExamplesDialog} (the sidebar's modal) and
 * inline beneath the drop zone in the panels' empty state. `onPicked` lets a
 * host react to a successful load (e.g. the modal closes itself).
 */
/**
 * An example's preview swatch. Decides its *own* checker from the image: a
 * light/white mark (e.g. white line-art) gets the dark checker so it stays
 * visible, everything else keeps the light one. This is per-thumbnail — it does
 * not follow the global preview backdrop.
 */
function ExampleThumb({ url, busy }: { url: string; busy: boolean }) {
  const [dark, setDark] = useState(false)

  useEffect(() => {
    let alive = true
    const img = new Image()
    img.onload = () => {
      if (alive) setDark(prefersDarkChecker(img))
    }
    img.src = url
    return () => {
      alive = false
    }
  }, [url])

  return (
    <div
      className={`${dark ? 'checkerboard-dark' : 'checkerboard'} relative flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-line`}
    >
      <img src={url} alt="" className="h-full w-full object-contain p-1.5" />
      {busy && (
        <div className="absolute inset-0 flex items-center justify-center bg-surface/70">
          <Loader2 size={18} className="animate-spin text-accent" />
        </div>
      )}
    </div>
  )
}

export function ExampleGrid({
  onPicked,
  className,
}: {
  onPicked?: () => void
  /** Grid column classes; defaults to a two-column layout. */
  className?: string
}) {
  const setLogo = useStore((s) => s.setLogo)
  const clearLogo = useStore((s) => s.clearLogo)
  const [loadingFile, setLoadingFile] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const pick = useCallback(
    async (ex: Example) => {
      if (loadingFile) return
      setError(null)
      setLoadingFile(ex.file)
      try {
        const res = await fetch(exampleUrl(ex.file))
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const blob = await res.blob()
        const file = new File([blob], ex.file, { type: blob.type || 'image/svg+xml' })
        clearLogo()
        const patch = await loadLogoFile(file)
        setLogo(patch)
        onPicked?.()
      } catch {
        setError('Could not load that example. Check your connection and try again.')
        setLoadingFile(null)
      }
    },
    [loadingFile, clearLogo, setLogo, onPicked],
  )

  return (
    <div className="flex flex-col gap-3">
      <div className={`grid gap-3 ${className ?? 'sm:grid-cols-2'}`}>
        {EXAMPLES.map((ex) => {
          const busy = loadingFile === ex.file
          return (
            <button
              key={ex.file}
              type="button"
              onClick={() => pick(ex)}
              disabled={!!loadingFile}
              className="scene-card group flex items-center gap-3 p-3 text-left disabled:opacity-60"
            >
              <ExampleThumb url={exampleUrl(ex.file)} busy={busy} />
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <p className="text-sm font-semibold text-ink">{ex.name}</p>
                  <span className="rounded bg-surface-3 px-1.5 py-0.5 font-mono text-[0.6rem] font-medium uppercase tracking-wide text-muted">
                    {fileFormat(ex.file)}
                  </span>
                </div>
                <p className="text-xs leading-snug text-muted">{ex.blurb}</p>
              </div>
            </button>
          )
        })}
      </div>
      {error && <p className="text-xs text-bad">{error}</p>}
    </div>
  )
}

function ExamplesDialog({ onClose }: { onClose: () => void }) {
  // Close on Escape. Capture-phase + stopPropagation so that when this dialog is
  // open inside an open <Sheet> (e.g. the mobile appearance drawer), Escape closes
  // only the dialog, not the sheet underneath.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Example logos"
    >
      {/* Backdrop */}
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-ink/40 backdrop-blur-sm dark:bg-black/55"
      />

      {/* Panel */}
      <div className="panel animate-in-fade relative z-10 flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden">
        <div className="flex items-start justify-between border-b border-line p-5">
          <div>
            <h2 className="text-base font-semibold text-ink">Example logos</h2>
            <p className="mt-1 text-sm text-muted">
              No logo handy? Load one of ours and experiment — clean it up, vectorize it, export an
              icon set.
            </p>
          </div>
          <Tooltip label="Close">
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="btn btn-ghost -mr-1.5 -mt-1.5 h-8 w-8 shrink-0 px-0"
            >
              <X size={16} />
            </button>
          </Tooltip>
        </div>

        <div className="overflow-y-auto p-5">
          <ExampleGrid onPicked={onClose} />
        </div>
      </div>
    </div>,
    document.body,
  )
}
