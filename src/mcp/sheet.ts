// A sheet of icons → one traced SVG per icon.
//
// Image models often answer "give me app icons" with a contact sheet: a grid of
// marks on one canvas. This is the app's sheet tab, headless: detect the tiles,
// crop each one (paper colour filling any overhang), plan and trace it as the
// batch does.
//
// Unlike the UI there is no caption OCR (tesseract.js needs a browser worker):
// tiles are named by position — or by the `names` the caller already knows, in
// reading order — and detected label tiles are reported so an agent can rename.
//
// Three things an icon SET needs that a single trace does not, all here:
//
//   * one ink. Every tile is probed on its own, and JPEG noise reads #010101 on
//     one tile and #000000 on the next. A tile's ink that is the sheet's ink
//     under noise (within the probe's own SAME_INK_DE) is written as the sheet's,
//     and an ink a hair off pure black or white is snapped to it. `ink` names
//     the paint outright (`currentColor` for a set that follows the text colour).
//   * no paper. The sheet tab defaults to Remove background so its tiles stay
//     transparent; so does this, unless `removeBackground: false`.
//   * no orphans. A run records what it wrote in `logolab-sheet.json`, and the
//     next run with the same prefix removes what it no longer produces — a
//     free-layout run that wrote 14 tiles, re-run as a 2×4 grid, leaves eight.
//     A `limit`ed run is a preview and removes nothing.

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cropTile, defaultTileName } from '../lib/sheet/crop.ts'
import { detectSheetIcons } from '../lib/sheet/detect.ts'
import { planTileTrace, tileTraceInput, traceTile } from '../lib/sheet/traceTile.ts'
import { deltaE76, srgbToLab } from '../lib/trace/lab.ts'
import { probeInk, SAME_INK_DE } from '../lib/traceInput/ink.ts'
import type { DetectOptions, ImageDataLike, SheetBackground, SheetTile } from '../lib/sheet/types'
import { pngFrom, rasterizeSource, type LoadedSource } from './image.ts'
import { ensureDir, ensureParent } from './runtime.ts'
import { baseOptions, finishTrace, inkPaint, type TraceRequest } from './trace.ts'

/**
 * Long side the sheet is decoded at. A sheet is a mosaic — one icon's crop is a
 * fraction of it — so it is decoded much larger than a single logo would be, and
 * each crop is capped again on its way into the tracer. (Mirrors SHEET_MAX_DIM in
 * src/components/sheet/sheetIo.ts, which is browser-side.)
 */
export const SHEET_MAX_DIM = 4096

/** What a run wrote, kept in the output directory so the next run can tidy up. */
export const SHEET_MANIFEST = 'logolab-sheet.json'

export interface SheetRequest extends Omit<TraceRequest, 'background' | 'regionDetail'> {
  /** Same knobs the tab exposes; every one is optional. */
  detect?: DetectOptions
  /** Enlarge small crops before tracing (mono only). Default on. */
  hiRes?: boolean
  /** Also write the cropped PNG beside each SVG. */
  keepCrops?: boolean
  /** File-name stem: `<prefix>-<nn>.svg`. Defaults to the sheet's own file name. */
  prefix?: string
  /** Names for the icons in reading order (row-major); icons past the list keep `<prefix>-<nn>`. */
  names?: string[]
  /** Cap how many tiles are traced (tracing is the slow part). */
  limit?: number
}

export interface SheetIconReport {
  name: string
  svgPath: string
  pngPath?: string
  /** Crop box in sheet pixels (x/y/w/h) — padded and squared as the detector decided. */
  box: { x: number; y: number; w: number; h: number }
  /** Grid position, row-major from the top-left; -1 in a free layout. */
  row: number
  col: number
  mode: 'color' | 'mono'
  /** The paint a mono tile was written in; null for a colour tile. */
  ink: string | null
  /** The thin ink's thickness in crop px (mono only; null when not measured). */
  inkThickness: number | null
  stats: { paths: number; nodes: number; colors: number }
}

export interface SheetReport {
  outDir: string
  sheet: { width: number; height: number }
  grid: { rows: number; cols: number } | null
  /** The sheet's dominant ink, which every mono tile of the same ink is written in. */
  ink: string | null
  /** Tiles the detector classified as caption text, not icons. */
  labels: { box: { x: number; y: number; w: number; h: number } }[]
  icons: SheetIconReport[]
  /** Files of a previous run with this prefix that this run no longer produces, deleted. */
  removed: string[]
  /** The manifest this run wrote, relative to `outDir`. */
  manifest: string
  warnings: string[]
  ms: number
}

/** Detect the tiles without tracing — the cheap half, for a dry run. */
export async function detectSheet(
  src: LoadedSource,
  req: SheetRequest = {},
): Promise<{
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
  const paint = inkPaint(req.ink)
  const { image, detection } = await detectSheet(src, req)
  const root = ensureDir(outDir)
  const warnings = [...detection.warnings]

  // The sheet tab's defaults: transparent tiles unless the paper is asked for.
  const base = baseOptions({ ...req, removeBackground: req.removeBackground ?? true })

  const background = detection.background
  // Overhang is filled with the sheet's own paper colour, so an icon at the edge
  // keeps its box instead of being clipped.
  const fill =
    background && !background.transparent ? { r: background.r, g: background.g, b: background.b, a: 255 } : null
  const dominant = sheetInk(image, background)

  const iconTiles = detection.tiles.filter((t) => t.kind === 'icon')
  const wanted = req.limit ? iconTiles.slice(0, req.limit) : iconTiles
  if (req.names && req.names.length !== iconTiles.length) {
    warnings.push(
      `${req.names.length} name${req.names.length === 1 ? '' : 's'} given for ${iconTiles.length} icon${iconTiles.length === 1 ? '' : 's'}; the rest are named by position.`,
    )
  }

  const stem = req.prefix ?? src.name
  const used = new Set<string>()
  const produced: string[] = []
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
    const ink = plan.opts.mode === 'mono' ? (paint ?? unifyInk(plan.recolor, dominant)) : null
    const traced = finishTrace(
      await traceTile(tileTraceInput(pixels, plan.scale), plan.opts, undefined, undefined, ink),
      req.normalize,
    )

    const name = uniqueName(fileStem(req.names?.[i]) || defaultTileName(i, stem), used)
    const svgPath = `${name}.svg`
    writeFileSync(ensureParent(join(root, svgPath)), traced.svg)
    produced.push(svgPath)
    let pngPath: string | undefined
    if (req.keepCrops) {
      pngPath = `${name}.png`
      writeFileSync(ensureParent(join(root, pngPath)), pngFrom(pixels))
      produced.push(pngPath)
    }

    icons.push({
      name,
      svgPath,
      pngPath,
      box: tile.box,
      row: tile.row,
      col: tile.col,
      mode: plan.opts.mode,
      ink,
      inkThickness: plan.thickness,
      stats: traced.stats,
    })
  }

  const removed = recordRun(root, stem, src.path, produced, !req.limit)

  return {
    outDir: root,
    sheet: { width: image.width, height: image.height },
    grid: detection.grid ? { rows: detection.grid.rows, cols: detection.grid.cols } : null,
    ink: paint ?? (dominant ? snapInk(dominant) : null),
    labels: detection.tiles.filter((t) => t.kind === 'label').map((t) => ({ box: t.box })),
    icons,
    removed,
    manifest: SHEET_MANIFEST,
    warnings,
    ms: Date.now() - started,
  }
}

/* ----------------------------------------------------------------- the ink */

/** The sheet's dominant ink (#rrggbb), read over the whole sheet; null when there is none. */
function sheetInk(image: ImageDataLike, background: SheetBackground | null): string | null {
  if (!background) return null
  try {
    const probe = probeInk(image, background)
    return probe.inks >= 1 ? probe.dominant : null
  } catch {
    return null
  }
}

/**
 * The paint a mono tile is written in: the sheet's ink when the tile's is the
 * same ink under noise (the probe's own fusion distance), else the tile's own —
 * either snapped to pure black or white when it is a hair off.
 */
export function unifyInk(tile: string | null, sheet: string | null): string | null {
  if (!tile) return null
  return snapInk(sheet && sameInk(tile, sheet) ? sheet : tile)
}

function sameInk(a: string, b: string): boolean {
  const [ar, ag, ab] = rgbOf(a)
  const [br, bg, bb] = rgbOf(b)
  return deltaE76(srgbToLab(ar, ag, ab), srgbToLab(br, bg, bb)) < SAME_INK_DE
}

/** JPEG makes #010101 of #000000 every time; nobody designs an icon set in #010101. */
export function snapInk(hex: string): string {
  const [r, g, b] = rgbOf(hex)
  if (r <= 3 && g <= 3 && b <= 3) return '#000000'
  if (r >= 252 && g >= 252 && b >= 252) return '#ffffff'
  return hex
}

function rgbOf(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? h.replace(/./g, (c) => c + c) : h
  const n = Number.parseInt(full, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/* --------------------------------------------------------------- the names */

/** A caller's name as a file stem: path separators and the characters no filesystem takes become dashes. */
export function fileStem(name: string | undefined): string {
  if (name == null) return ''
  return name
    .trim()
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** Two tiles given one name would write one file; the second gets `-2`. */
function uniqueName(name: string, used: Set<string>): string {
  let out = name
  for (let k = 2; used.has(out); k++) out = `${name}-${k}`
  used.add(out)
  return out
}

/* ------------------------------------------------------------ the manifest */

interface SheetManifest {
  version: 1
  runs: Record<string, { sheet: string; at: string; files: string[] }>
}

function readManifest(root: string): SheetManifest {
  const empty: SheetManifest = { version: 1, runs: {} }
  const path = join(root, SHEET_MANIFEST)
  if (!existsSync(path)) return empty
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<SheetManifest>
    if (parsed.version !== 1 || typeof parsed.runs !== 'object' || parsed.runs === null) return empty
    return { version: 1, runs: parsed.runs }
  } catch {
    return empty
  }
}

/**
 * Record what this run wrote and, when `tidy`, delete what the previous run with
 * the same prefix wrote that this one did not — only files the manifest lists,
 * only plain names beside the manifest, only the kinds this tool writes. A run
 * that does not tidy (a `limit`ed preview) ADDS to the record instead of
 * replacing it, so the full run after it still knows what the earlier full run
 * wrote.
 */
function recordRun(root: string, prefix: string, sheet: string, files: string[], tidy: boolean): string[] {
  const manifest = readManifest(root)
  const previous = manifest.runs[prefix]?.files ?? []
  const removed: string[] = []
  if (tidy) {
    const current = new Set(files)
    for (const f of previous) {
      if (current.has(f) || /[\\/]/.test(f) || !/\.(svg|png)$/i.test(f)) continue
      const path = join(root, f)
      if (!existsSync(path)) continue
      unlinkSync(path)
      removed.push(f)
    }
  }
  const record = tidy ? files : [...new Set([...previous, ...files])]
  manifest.runs[prefix] = { sheet, at: new Date().toISOString(), files: record }
  writeFileSync(join(root, SHEET_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`)
  return removed
}
