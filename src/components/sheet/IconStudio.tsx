// One icon of the sheet, in the real vectorizer.
//
// No fork and no second tracer: this crops the tile to its own image and hands it
// to `VectorizeStudio` with a different source, a different Apply, and its own
// trace parameters. Everything the studio can do to a logo — node editing,
// markers, palette, undo — it does here to one icon of the sheet.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Grid2x2, ImageDown, Loader2 } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { VectorizeStudio, type VectorizeSource } from '../vectorize/VectorizeStudio'
import { Tooltip } from '../ui/Tooltip'
import { canvasToBlob, imageDataToCanvas } from '../../lib/image'
import { cropTile, toImageData, type ImageDataLike } from '../../lib/sheet'
import { planTileTrace, tileTraceInput } from '../../lib/sheet/traceTile'
import { useStore } from '../../store'
import { useSheetStore, type SheetIcon } from '../../sheetStore'
import type { EditableDoc } from '../../lib/path/types'

/** How long the studio's live edits settle before they are written back. */
const SYNC_MS = 350

export interface IconStudioProps {
  tile: SheetIcon
  image: ImageDataLike
  background: { r: number; g: number; b: number; transparent: boolean } | null
  index: number
  total: number
  onBack: () => void
  onStep: (delta: number) => void
}

export function IconStudio({ tile, image, background, index, total, onBack, onStep }: IconStudioProps) {
  const navigate = useNavigate()
  const setLogo = useStore((s) => s.setLogo)
  const traceOptions = useSheetStore((s) => s.traceOptions)
  const colorMode = useSheetStore((s) => s.colorMode)
  const hiRes = useSheetStore((s) => s.hiRes)
  const gradientMode = useSheetStore((s) => s.gradientMode)
  const sheetBackground = useSheetStore((s) => s.background)
  const setTileDoc = useSheetStore((s) => s.setTileDoc)
  const updateTile = useSheetStore((s) => s.updateTile)

  const pixels = useMemo(
    () =>
      cropTile(
        image,
        tile.rect,
        background && !background.transparent ? { r: background.r, g: background.g, b: background.b, a: 255 } : null,
      ),
    [image, tile.rect, background],
  )

  /**
   * The studio runs its OWN trace whenever a control moves, so it has to start
   * from the same pixels the batch used — the enlarged crop. Handing it the
   * native crop instead would quietly re-trace the icon at lower quality the
   * moment the user touched a slider.
   */
  const plan = useMemo(
    () => planTileTrace(pixels, tile.opts ?? traceOptions, { colorMode, gradientMode, background: sheetBackground, hiRes }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pixels, tile.id],
  )
  const traceInput = useMemo(() => tileTraceInput(pixels, plan.scale), [pixels, plan.scale])

  // The studio takes its image as a URL (it decodes and re-rasterizes at the
  // trace cap), so the crop is materialized as a blob URL — owned and revoked
  // here, since nothing downstream knows it exists.
  const [source, setSource] = useState<VectorizeSource | null>(null)
  const [cutError, setCutError] = useState<string | null>(null)
  useEffect(() => {
    let url: string | null = null
    let cancelled = false
    void (async () => {
      try {
        // `toImageData` is not decoration: the crop is a plain {width,height,data},
        // and putImageData rejects anything that is not a real ImageData.
        const blob = await canvasToBlob(imageDataToCanvas(toImageData(traceInput)), 'image/png')
        if (cancelled) return
        url = URL.createObjectURL(blob)
        setSource({
          src: url,
          isSvg: false,
          svgText: null,
          naturalWidth: traceInput.width,
          naturalHeight: traceInput.height,
          fileName: `${tile.name}.png`,
        })
      } catch (err) {
        if (!cancelled) setCutError(err instanceof Error ? err.message : 'Could not cut this icon out of the sheet.')
      }
    })()
    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [traceInput, tile.name])

  // Live node edits fire on every drag frame; writing each one into the sheet
  // store would rebuild the whole tile array per frame. Settle first.
  const syncTimer = useRef<number | null>(null)
  const latest = useRef<{ doc: EditableDoc; svgText: string; stats: SheetIcon['stats'] } | null>(null)
  const onResult = useCallback(
    (result: { doc: EditableDoc; svgText: string; stats: { paths: number; nodes: number; colors: number } } | null) => {
      if (!result) return
      latest.current = result
      if (syncTimer.current !== null) window.clearTimeout(syncTimer.current)
      syncTimer.current = window.setTimeout(() => {
        syncTimer.current = null
        const r = latest.current
        if (r) setTileDoc(tile.id, r.doc, r.svgText, r.stats)
      }, SYNC_MS)
    },
    [setTileDoc, tile.id],
  )
  useEffect(
    () => () => {
      if (syncTimer.current === null) return
      window.clearTimeout(syncTimer.current)
      const r = latest.current
      if (r) setTileDoc(tile.id, r.doc, r.svgText, r.stats)
    },
    [setTileDoc, tile.id],
  )

  const onOptionsChange = useCallback(
    (opts: typeof traceOptions) => updateTile(tile.id, { opts }),
    [updateTile, tile.id],
  )

  /**
   * The controls must describe the document on screen. A batch run decides colour
   * vs mono PER TILE, so the sheet defaults are not what this icon was traced
   * with — open on the resolved options (or, for a tile the batch never reached,
   * on the same decision the batch would make).
   */
  const initialOptions = useMemo(() => tile.opts ?? tile.resolved ?? plan.opts, [tile.id, plan])

  /** Push this icon into the app's working logo, for the Cleanup / Export tabs. */
  const sendToLogo = async () => {
    const blob = await canvasToBlob(imageDataToCanvas(toImageData(pixels)), 'image/png')
    const url = URL.createObjectURL(blob)
    setLogo({
      src: url,
      originalSrc: url,
      fileName: `${tile.name}.png`,
      mime: 'image/png',
      isSvg: false,
      svgText: null,
      naturalWidth: pixels.width,
      naturalHeight: pixels.height,
    })
    navigate('/cleanup')
  }

  const leading = (
    <div className="flex shrink-0 items-center gap-1">
      <Tooltip label="Back to all icons">
        <button type="button" onClick={onBack} className="btn btn-secondary h-8 gap-1.5 px-2.5 text-xs">
          <Grid2x2 size={14} />
          All icons
        </button>
      </Tooltip>
      <div className="flex items-center rounded-lg bg-surface-3 p-0.5">
        <button
          type="button"
          onClick={() => onStep(-1)}
          disabled={total < 2}
          aria-label="Previous icon"
          className="btn btn-ghost h-7 w-7 px-0"
        >
          <ChevronLeft size={14} />
        </button>
        <span className="px-1 font-mono text-[0.7rem] tabular-nums text-muted">
          {index + 1}/{total}
        </span>
        <button
          type="button"
          onClick={() => onStep(1)}
          disabled={total < 2}
          aria-label="Next icon"
          className="btn btn-ghost h-7 w-7 px-0"
        >
          <ChevronRight size={14} />
        </button>
      </div>
      <Tooltip label="Send this icon to the Cleanup tab as the working logo">
        <button type="button" onClick={() => void sendToLogo()} className="btn btn-ghost h-8 w-8 px-0">
          <ImageDown size={15} />
        </button>
      </Tooltip>
      <span className="h-5 w-px bg-line" aria-hidden />
    </div>
  )

  if (!source) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted">
        {cutError ? (
          <>
            <p className="text-bad">{cutError}</p>
            <button type="button" onClick={onBack} className="btn btn-secondary h-8 px-3 text-xs">
              Back to all icons
            </button>
          </>
        ) : (
          <span className="flex items-center gap-2">
            <Loader2 size={16} className="animate-spin text-accent" />
            Cutting the icon…
          </span>
        )}
      </div>
    )
  }

  return (
    <VectorizeStudio
      // Remounting per tile is deliberate: each icon gets its own undo history,
      // its own trace state and its own seeded document.
      key={tile.id}
      source={source}
      initialDoc={tile.doc}
      initialOptions={initialOptions}
      onOptionsChange={onOptionsChange}
      onResult={onResult}
      onApply={() => onBack()}
      applyLabel="Done"
      appliedLabel="Saved"
      leading={leading}
    />
  )
}
