// A sheet of icons → one traced SVG per icon.
//
// Image models like to answer "give me app icons" with a CONTACT SHEET: a grid of
// twelve marks on one canvas. The app has a whole tab for cutting those up; this
// is that flow headless — detect the tiles, crop each one (paper colour filling
// any overhang), plan and trace it exactly as the batch does.
//
// The one thing missing against the UI is caption OCR: the tab names each icon
// after the label printed under it via tesseract.js, which needs a browser worker.
// Here tiles are named by position, and the DETECTED label tiles are reported so
// an agent can rename them itself if it wants.

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cropTile, defaultTileName } from '../lib/sheet/crop.ts'
import { detectSheetIcons } from '../lib/sheet/detect.ts'
import { planTileTrace, tileTraceInput, traceTile } from '../lib/sheet/traceTile.ts'
import { DEFAULT_VECTORIZE_OPTIONS } from '../lib/trace/index.ts'
import type { DetectOptions, ImageDataLike, SheetTile } from '../lib/sheet/types'
import type { VectorizeOptions } from '../types'
import { pngFrom, rasterizeSource, type LoadedSource } from './image.ts'
import { ensureDir, ensureParent } from './runtime.ts'

/**
 * Long side the sheet is decoded at. A sheet is a mosaic — one icon's crop is a
 * fraction of it — so it is decoded much larger than a single logo would be, and
 * each crop is capped again on its way into the tracer. (Mirrors SHEET_MAX_DIM in
 * src/components/sheet/sheetIo.ts, which is browser-side.)
 */
export const SHEET_MAX_DIM = 4096

export interface SheetRequest {
  /** Same knobs the tab exposes; every one is optional. */
  detect?: DetectOptions
  mode?: 'auto' | 'color' | 'mono'
  gradients?: 'auto' | 'flat' | 'rich'
  /** Enlarge small crops before tracing (mono only). Default on — it is measurably better. */
  hiRes?: boolean
  /** Also write the cropped PNG beside each SVG. */
  keepCrops?: boolean
  /** File-name stem: `<prefix><nn>.svg`. Defaults to the sheet's own file name. */
  prefix?: string
  smoothing?: number
  despeckle?: number
  /** Cap how many tiles are traced (tracing is the slow part). */
  limit?: number
}

export interface SheetIconReport {
  name: string
  svgPath: string
  pngPath?: string
  /** Crop box in sheet pixels (x/y/w/h) — padded and squared as the detector decided. */
  box: { x: number; y: number; w: number; h: number }
  row: number
  col: number
  mode: 'color' | 'mono'
  stats: { paths: number; nodes: number; colors: number }
}

export interface SheetReport {
  outDir: string
  sheet: { width: number; height: number }
  grid: { rows: number; cols: number } | null
  /** Tiles the detector classified as caption text, not icons. */
  labels: { box: { x: number; y: number; w: number; h: number } }[]
  icons: SheetIconReport[]
  warnings: string[]
  ms: number
}

/** Detect the tiles without tracing — the cheap half, for a dry run. */
export async function detectSheet(src: LoadedSource, req: SheetRequest = {}): Promise<{
  image: ImageDataLike
  tiles: SheetTile[]
  detection: ReturnType<typeof detectSheetIcons>
}> {
  const image = await rasterizeSource(src, SHEET_MAX_DIM)
  const detection = detectSheetIcons(image, req.detect ?? {})
  return { image, tiles: detection.tiles, detection }
}

/** Detect, crop, trace and write every icon on the sheet. */
export async function splitSheet(src: LoadedSource, outDir: string, req: SheetRequest = {}): Promise<SheetReport> {
  const started = Date.now()
  const { image, detection } = await detectSheet(src, req)
  const root = ensureDir(outDir)

  const base: VectorizeOptions = { ...DEFAULT_VECTORIZE_OPTIONS }
  if (req.smoothing != null) base.smoothing = req.smoothing
  if (req.despeckle != null) base.despeckle = req.despeckle

  const background = detection.background
  // Overhang is filled with the sheet's own paper colour, so an icon at the edge
  // keeps its box instead of being clipped.
  const fill = background && !background.transparent ? { r: background.r, g: background.g, b: background.b, a: 255 } : null

  const iconTiles = detection.tiles.filter((t) => t.kind === 'icon')
  const wanted = req.limit ? iconTiles.slice(0, req.limit) : iconTiles

  const icons: SheetIconReport[] = []
  for (let i = 0; i < wanted.length; i++) {
    const tile = wanted[i]
    const pixels = cropTile(image, tile.box, fill)
    const plan = planTileTrace(pixels, base, {
      colorMode: req.mode ?? 'auto',
      gradientMode: req.gradients ?? 'auto',
      background,
      hiRes: req.hiRes,
    })
    const traced = await traceTile(tileTraceInput(pixels, plan.scale), plan.opts, undefined, undefined, plan.recolor)

    const name = defaultTileName(i, req.prefix ?? src.name)
    const svgPath = `${name}.svg`
    writeFileSync(ensureParent(join(root, svgPath)), traced.svg)
    let pngPath: string | undefined
    if (req.keepCrops) {
      pngPath = `${name}.png`
      writeFileSync(ensureParent(join(root, pngPath)), pngFrom(pixels))
    }

    icons.push({
      name,
      svgPath,
      pngPath,
      box: tile.box,
      row: tile.row,
      col: tile.col,
      mode: plan.opts.mode,
      stats: traced.stats,
    })
  }

  return {
    outDir: root,
    sheet: { width: image.width, height: image.height },
    grid: detection.grid ? { rows: detection.grid.rows, cols: detection.grid.cols } : null,
    labels: detection.tiles.filter((t) => t.kind === 'label').map((t) => ({ box: t.box })),
    icons,
    warnings: detection.warnings,
    ms: Date.now() - started,
  }
}
