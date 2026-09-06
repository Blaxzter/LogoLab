// The detected icons, as a contact sheet.
//
// One card per crop: the pixels on the left of the split, the trace on the right
// once it exists. The card is the batch's status display (queued / tracing /
// traced / failed) and its remote control (include, rename, open, download).

import { memo, useEffect, useMemo, useRef } from 'react'
import { AlertTriangle, Check, Download, Loader2, Pencil, ScanText, Type } from 'lucide-react'
import { cleanAffix, cropTile, exportName, toImageData, type ImageDataLike, type Rect } from '../../lib/sheet'
import { downloadText } from '../../lib/download'
import { CAPTION_UNSURE_BELOW, type SheetIcon, type SheetNaming } from '../../sheetStore'

export interface IconGridProps {
  image: ImageDataLike
  background: { r: number; g: number; b: number; transparent: boolean } | null
  tiles: SheetIcon[]
  naming: SheetNaming
  checkerClass: string
  /** Show the traced result instead of the source pixels where one exists. */
  showTraced: boolean
  onOpen: (id: string) => void
  onToggleInclude: (id: string, included: boolean) => void
  onRename: (id: string, name: string) => void
}

export function IconGrid({
  image,
  background,
  tiles,
  naming,
  checkerClass,
  showTraced,
  onOpen,
  onToggleInclude,
  onRename,
}: IconGridProps) {
  return (
    <div className="grid grid-cols-2 gap-3 p-3 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-6">
      {tiles.map((tile, index) => (
        <IconCard
          key={tile.id}
          index={index}
          tile={tile}
          image={image}
          background={background}
          naming={naming}
          checkerClass={checkerClass}
          showTraced={showTraced}
          onOpen={onOpen}
          onToggleInclude={onToggleInclude}
          onRename={onRename}
        />
      ))}
    </div>
  )
}

function IconCard({
  index,
  tile,
  image,
  background,
  naming,
  checkerClass,
  showTraced,
  onOpen,
  onToggleInclude,
  onRename,
}: {
  index: number
  tile: SheetIcon
  image: ImageDataLike
  background: IconGridProps['background']
  naming: SheetNaming
  checkerClass: string
  showTraced: boolean
  onOpen: (id: string) => void
  onToggleInclude: (id: string, included: boolean) => void
  onRename: (id: string, name: string) => void
}) {
  const traced = showTraced && tile.svg ? tile.svg : null
  const prefix = cleanAffix(naming.prefix)
  const suffix = cleanAffix(naming.suffix)
  // The name came off the sheet, not from the user — say so, and say when the
  // read was shaky: a misread caption is otherwise a misnamed file nobody sees.
  const caption = naming.fromCaptions && !tile.renamed && tile.caption?.text != null ? tile.caption : null
  const confidence = caption ? Math.round(caption.confidence ?? 0) : 0
  const unsure = caption !== null && (caption.text === '' || confidence < CAPTION_UNSURE_BELOW)

  return (
    <div
      className={`scene-card flex flex-col ${tile.included ? '' : 'opacity-55'} ${
        tile.status === 'error' ? 'border-bad/50' : ''
      }`}
    >
      <button
        type="button"
        onClick={() => onOpen(tile.id)}
        title="Open this icon in the vectorizer"
        className={`relative block aspect-square w-full ${checkerClass}`}
      >
        {traced ? (
          <img src={svgDataUrl(traced)} alt="" className="absolute inset-0 h-full w-full object-contain p-2" />
        ) : (
          <TileCanvas image={image} rect={tile.rect} background={background} className="absolute inset-0 h-full w-full object-contain" />
        )}

        <span className="absolute left-1.5 top-1.5 rounded bg-ink/55 px-1.5 py-0.5 font-mono text-[0.6rem] tabular-nums text-white">
          {index + 1}
        </span>

        {tile.kind === 'label' && (
          <span
            title="The detector read this as caption text, not an icon"
            className="absolute right-1.5 top-1.5 flex items-center gap-1 rounded bg-surface/85 px-1.5 py-0.5 text-[0.6rem] font-semibold text-muted backdrop-blur"
          >
            <Type size={9} /> text
          </span>
        )}

        {(tile.status === 'tracing' || tile.status === 'queued') && (
          <span className="absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-surface/85 px-2 py-1 text-[0.65rem] font-medium text-accent backdrop-blur">
            <Loader2 size={11} className="animate-spin" />
            {tile.status === 'queued' ? 'Queued' : `Tracing ${Math.round(tile.progress * 100)}%`}
          </span>
        )}
        {tile.status === 'error' && (
          <span className="absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-bad/90 px-2 py-1 text-[0.65rem] font-medium text-white">
            <AlertTriangle size={11} />
            {tile.error ?? 'Trace failed'}
          </span>
        )}
      </button>

      <div className="flex items-center gap-1.5 border-t border-line px-2 py-1.5">
        <input
          type="checkbox"
          checked={tile.included}
          onChange={(e) => onToggleInclude(tile.id, e.target.checked)}
          title={tile.included ? 'Included in trace & export' : 'Excluded'}
          className="size-3.5 shrink-0 accent-[var(--color-accent)]"
        />
        <div className="flex min-w-0 flex-1 items-center">
          {prefix && (
            <span className="max-w-[40%] shrink-0 truncate text-xs text-faint" title={prefix}>
              {prefix}
            </span>
          )}
          <input
            value={tile.name}
            onChange={(e) => onRename(tile.id, e.target.value)}
            spellCheck={false}
            className="min-w-0 flex-1 truncate rounded border border-transparent bg-transparent px-1 py-0.5 text-xs text-ink-2 outline-none hover:border-line focus:border-accent focus:bg-surface"
          />
          {suffix && (
            <span className="max-w-[40%] shrink-0 truncate text-xs text-faint" title={suffix}>
              {suffix}
            </span>
          )}
        </div>
        {caption && (
          <span
            title={
              caption.text === ''
                ? 'The caption under this icon could not be read — numbered instead'
                : unsure
                  ? `Read from the caption with low confidence (${confidence}%): “${caption.text}” — check the name`
                  : `Named from its caption “${caption.text}” (${confidence}%)`
            }
            className={`flex h-6 w-6 shrink-0 items-center justify-center ${unsure ? 'text-warn' : 'text-faint'}`}
          >
            {unsure ? <AlertTriangle size={12} /> : <ScanText size={12} />}
          </span>
        )}
        {tile.svg && (
          <button
            type="button"
            title="Download this icon as SVG"
            onClick={() =>
              downloadText(tile.svg!, `${exportName(tile.name, naming.prefix, naming.suffix)}.svg`, 'image/svg+xml')
            }
            className="btn btn-ghost h-6 w-6 shrink-0 px-0"
          >
            <Download size={12} />
          </button>
        )}
        <button
          type="button"
          title="Open in the vectorizer"
          onClick={() => onOpen(tile.id)}
          className="btn btn-ghost h-6 w-6 shrink-0 px-0"
        >
          <Pencil size={12} />
        </button>
      </div>

      <div className="flex items-center gap-2 border-t border-line px-2 py-1 font-mono text-[0.6rem] tabular-nums text-faint">
        <span>
          {Math.round(tile.rect.w)}×{Math.round(tile.rect.h)}
        </span>
        {tile.stats && (
          <span className="truncate">
            {tile.stats.paths}p · {tile.stats.nodes}n
          </span>
        )}
        <span className="ml-auto shrink-0">
          {tile.stale && tile.doc ? (
            <span className="text-warn">stale</span>
          ) : tile.status === 'done' ? (
            <Check size={11} className="text-good" />
          ) : null}
        </span>
      </div>
    </div>
  )
}

/** A crop, painted at its native size and left to the browser to scale down. */
const TileCanvas = memo(function TileCanvas({
  image,
  rect,
  background,
  className,
}: {
  image: ImageDataLike
  rect: Rect
  background: IconGridProps['background']
  className?: string
}) {
  const ref = useRef<HTMLCanvasElement | null>(null)
  const pixels = useMemo(
    () =>
      cropTile(
        image,
        rect,
        background && !background.transparent ? { r: background.r, g: background.g, b: background.b, a: 255 } : null,
      ),
    [image, rect.x, rect.y, rect.w, rect.h, background],
  )

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    canvas.width = pixels.width
    canvas.height = pixels.height
    const ctx = canvas.getContext('2d')
    ctx?.putImageData(toImageData(pixels), 0, 0)
  }, [pixels])

  return <canvas ref={ref} className={className} />
})

function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}
