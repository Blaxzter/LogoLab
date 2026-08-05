// Getting a sheet in, and getting the icons back out.
//
// Everything here composes existing app primitives — `loadLogoFile` for intake,
// `bgRemove` for the paper knockout, `serializeDoc` output for the SVGs, JSZip
// (already an app dependency, used by the PWA export) for the archive.

import JSZip from 'jszip'
import { autoRemove, cloneImageData, defringe, despeckle } from '../../lib/bgRemove'
import { canvasToBlob, getImageData, imageDataToCanvas, loadLogoFile } from '../../lib/image'
import { toImageData } from '../../lib/sheet'
import type { ImageDataLike } from '../../lib/sheet'
import type { SheetIcon, SheetSource } from '../../sheetStore'

/**
 * Long side the sheet is decoded at. A sheet is a mosaic — the per-icon crop is
 * a fraction of it — so it is decoded much larger than a single logo would be,
 * and each crop is capped again on its way into the tracer.
 */
export const SHEET_MAX_DIM = 4096

export interface SheetIntake {
  source: SheetSource
  image: ImageDataLike
}

export async function readSheetFile(file: File): Promise<SheetIntake> {
  const loaded = await loadLogoFile(file)
  const image = await getImageData(loaded.src, SHEET_MAX_DIM, loaded.isSvg ? loaded.svgText : null)
  return {
    source: {
      src: loaded.src,
      fileName: loaded.fileName ?? file.name,
      // The sheet's coordinate space is the DECODED raster, not the file's
      // natural size — every tile rect is in these pixels.
      width: image.width,
      height: image.height,
      svgText: loaded.svgText ?? null,
      owned: true,
    },
    image,
  }
}

export function isImageFile(file: File): boolean {
  return /^image\//.test(file.type) || /\.svg$/i.test(file.name)
}

/**
 * Knock the sheet's paper colour out of a crop: flood from the four corners (so
 * a white shape INSIDE the icon survives), then tidy the halo the flood leaves
 * behind. Exactly the sequence the Cleanup studio's one-click Auto runs.
 */
export function knockoutBackground(tile: ImageDataLike, tolerance = 32, softness = 0.35): ImageData {
  // cloneImageData constructs a real ImageData, which is what the bgRemove passes
  // (and the canvas below) require — a crop is a plain {width,height,data}.
  const img = cloneImageData(tile as ImageData)
  const { color } = autoRemove(img, { tolerance, softness })
  despeckle(img)
  defringe(img, color, 1)
  return img
}

export function toDataUrl(img: ImageDataLike): string {
  return imageDataToCanvas(toImageData(img)).toDataURL('image/png')
}

export interface SheetExportOptions {
  svg: boolean
  png: boolean
  /** Knock the paper colour out of the exported PNGs. */
  transparent: boolean
}

export interface SheetExportItem {
  tile: SheetIcon
  pixels: ImageDataLike | null
}

/**
 * One archive for the whole sheet — N anchor clicks in a row get throttled by
 * browsers, and a set of icons is one deliverable anyway. Flat when only one
 * format is asked for, `svg/` + `png/` when both.
 */
export async function buildSheetZip(items: SheetExportItem[], opts: SheetExportOptions): Promise<Blob> {
  const zip = new JSZip()
  const both = opts.svg && opts.png
  const used = new Map<string, number>()

  for (const { tile, pixels } of items) {
    // Two icons can end up with the same name (the user renamed one onto
    // another); a zip with duplicate paths silently loses entries.
    const seen = used.get(tile.name) ?? 0
    used.set(tile.name, seen + 1)
    const name = seen === 0 ? tile.name : `${tile.name}-${seen + 1}`

    if (opts.svg && tile.svg) {
      zip.file(both ? `svg/${name}.svg` : `${name}.svg`, tile.svg)
    }
    if (opts.png && pixels) {
      const out = opts.transparent ? knockoutBackground(pixels) : toImageData(pixels)
      const blob = await canvasToBlob(imageDataToCanvas(out), 'image/png')
      zip.file(both ? `png/${name}.png` : `${name}.png`, await blob.arrayBuffer())
    }
  }
  return zip.generateAsync({ type: 'blob' })
}
