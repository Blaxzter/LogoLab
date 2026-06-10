import { useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import { useLogoUpload } from '../hooks/useLogoUpload'
import { ExampleGrid } from './ExamplesDialog'

/**
 * The big, full-width drop zone the Cleanup / Vectorize / Export panels show
 * when no logo is loaded. The whole box is the drop + click target, so the user
 * can load a logo right where they're looking instead of hunting for the sidebar
 * uploader. Shares its intake logic with the sidebar via {@link useLogoUpload}.
 */
export function PanelEmptyState({
  icon,
  title,
  subtitle,
}: {
  icon: ReactNode
  title: string
  subtitle: string
}) {
  const { handleFile, loading, error } = useLogoUpload()
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  return (
    <div className="flex flex-col items-center gap-4 animate-in-fade">
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          handleFile(e.dataTransfer.files?.[0])
        }}
        className={`flex w-full flex-col items-center justify-center gap-4 rounded-xl border-2 border-dashed px-6 py-20 text-center transition-colors ${
          dragging
            ? 'border-accent bg-accent-soft'
            : 'border-line-strong bg-surface-2 hover:border-faint hover:bg-surface-3'
        }`}
      >
        <div
          className={`flex h-14 w-14 items-center justify-center rounded-full transition-colors ${
            dragging ? 'bg-accent-soft text-accent' : 'bg-surface-3 text-muted'
          }`}
        >
          {loading ? <Loader2 size={26} className="animate-spin text-accent" /> : icon}
        </div>
        <div>
          <p className="text-base font-medium text-ink">{dragging ? 'Drop to load it' : title}</p>
          <p className="mt-1 text-sm text-muted">{subtitle}</p>
          <p className="mt-2 text-xs text-faint">
            Drop a file or <span className="font-medium text-muted">click to browse</span> · PNG, SVG, JPG, WebP
          </p>
        </div>
      </button>

      {error && <p className="text-sm text-bad">{error}</p>}

      {/* No logo handy? Start from a bundled example — cards inline, no modal. */}
      <div className="w-full">
        <div className="mb-3 flex items-center gap-3">
          <span className="h-px flex-1 bg-line" />
          <span className="text-xs font-medium uppercase tracking-wider text-faint">
            Or start with an example
          </span>
          <span className="h-px flex-1 bg-line" />
        </div>
        <ExampleGrid className="sm:grid-cols-2 lg:grid-cols-3" />
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/*,.svg"
        className="hidden"
        onChange={(e) => handleFile(e.target.files?.[0])}
      />
    </div>
  )
}
