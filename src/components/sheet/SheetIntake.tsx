// The "drop a sheet here" state.
//
// It is NOT `PanelEmptyState`: that one always writes the app's working logo,
// and a sheet must not clobber the logo the user is preparing on the other tabs.
// The drop-target markup and copy deliberately mirror it so the app reads as one
// thing; only the destination differs.

import { useRef, useState } from 'react'
import { Loader2, LayoutGrid } from 'lucide-react'
import { useLogo } from '../../store'
import { useSheetStore } from '../../sheetStore'
import { getImageData } from '../../lib/image'
import { isImageFile, readSheetFile, SHEET_MAX_DIM } from './sheetIo'

export function SheetIntake() {
  const setSource = useSheetStore((s) => s.setSource)
  const logo = useLogo()
  const [dragging, setDragging] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const load = async (file: File | undefined | null) => {
    if (!file) return
    if (!isImageFile(file)) {
      setError('Please drop an image file (PNG, JPG, WebP, SVG…).')
      return
    }
    setError(null)
    setLoading(true)
    try {
      const intake = await readSheetFile(file)
      setSource(intake.source, intake.image)
    } catch {
      setError('Could not read that file.')
    } finally {
      setLoading(false)
    }
  }

  /** Take whatever is already loaded on the other tabs as the sheet. */
  const useCurrentLogo = async () => {
    if (!logo.src) return
    setError(null)
    setLoading(true)
    try {
      const image = await getImageData(logo.src, SHEET_MAX_DIM, logo.isSvg ? logo.svgText : null)
      setSource(
        {
          // Not ours to revoke — the store owns this URL — so it is passed as-is
          // and `setSource` only revokes URLs it created.
          src: logo.src,
          fileName: logo.fileName,
          width: image.width,
          height: image.height,
          svgText: logo.isSvg ? logo.svgText : null,
          owned: false,
        },
        image,
      )
    } catch {
      setError('Could not read the current image.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="mx-auto flex max-w-4xl flex-col items-center gap-4 p-6 animate-in-fade">
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
          void load(e.dataTransfer.files?.[0])
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
          {loading ? <Loader2 size={26} className="animate-spin text-accent" /> : <LayoutGrid size={26} />}
        </div>
        <div>
          <p className="text-base font-medium text-ink">
            {dragging ? 'Drop to split it' : 'Drop an icon sheet'}
          </p>
          <p className="mt-1 max-w-md text-sm text-muted">
            One image holding a set of icons — the kind an image model hands you. Every icon is found, cropped and
            traced to its own clean SVG.
          </p>
          <p className="mt-2 text-xs text-faint">
            Drop a file or <span className="font-medium text-muted">click to browse</span> · PNG, SVG, JPG, WebP
          </p>
        </div>
      </button>

      {error && <p className="text-sm text-bad">{error}</p>}

      {logo.src && (
        <button type="button" onClick={() => void useCurrentLogo()} className="btn btn-secondary h-9 text-xs">
          Use the loaded image ({logo.fileName ?? 'current logo'})
        </button>
      )}

      <div className="w-full rounded-lg border border-line bg-surface p-4 text-sm leading-relaxed text-muted">
        <h3 className="mb-1 text-sm font-semibold text-ink">How it works</h3>
        <ol className="ml-4 list-decimal space-y-1">
          <li>The sheet's paper colour is measured, and the artwork on it is grouped into icons — captions and
            titles are recognised and set aside.</li>
          <li>Check the split on the <strong>Sheet</strong> view: drag a box, resize it, draw a missing one.</li>
          <li><strong>Trace</strong> runs the vectorizer over every icon, a few at a time.</li>
          <li>Open any icon for the full editor, then download the set as one zip.</li>
        </ol>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/*,.svg"
        className="hidden"
        onChange={(e) => {
          void load(e.target.files?.[0])
          e.target.value = ''
        }}
      />
    </div>
  )
}
