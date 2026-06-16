import { useRef, useState } from 'react'
import { ImageUp, Loader2, X } from 'lucide-react'
import { useCheckerClass, useLogo, useStore } from '../store'
import { useLogoUpload } from '../hooks/useLogoUpload'
import { Tooltip } from './ui/Tooltip'

export function UploadDropzone() {
  const logo = useLogo()
  const clearLogo = useStore((s) => s.clearLogo)
  const checkerClass = useCheckerClass()
  const { handleFile, loading, error } = useLogoUpload()
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  if (logo.src) {
    return (
      <div className="panel flex items-center gap-3 p-3">
        <div className={`${checkerClass} flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-line`}>
          <img src={logo.src} alt="" className="h-full w-full object-contain p-1" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-ink">{logo.fileName}</p>
          <p className="text-xs text-muted">
            {logo.isSvg ? 'SVG' : `${logo.naturalWidth}×${logo.naturalHeight}`}
            {logo.isSvg ? '' : ' px'}
          </p>
        </div>
        <button
          onClick={() => inputRef.current?.click()}
          className="btn btn-ghost h-8 px-2 text-xs"
        >
          Replace
        </button>
        <Tooltip label="Remove logo">
          <button
            onClick={clearLogo}
            aria-label="Remove logo"
            className="btn btn-ghost h-8 w-8 px-0"
          >
            <X size={15} />
          </button>
        </Tooltip>
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

  return (
    <div className="flex flex-col gap-2">
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
        className={`flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-7 text-center transition-colors ${
          dragging
            ? 'border-accent bg-accent-soft'
            : 'border-line-strong bg-surface-2 hover:border-faint hover:bg-surface-3'
        }`}
      >
        {loading ? (
          <Loader2 size={22} className="animate-spin text-accent" />
        ) : (
          <ImageUp size={22} className={dragging ? 'text-accent' : 'text-muted'} />
        )}
        <div>
          <p className="text-sm font-medium text-ink">Drop a logo here</p>
          <p className="text-xs text-muted">or click to browse · PNG, SVG, JPG, WebP</p>
        </div>
      </button>
      {error && <p className="text-xs text-bad">{error}</p>}
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
