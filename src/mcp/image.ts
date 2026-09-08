// Reading pixels in, and writing pixels out, without a browser.
//
// The app gets both from canvas. Here the decoder is picked PER FORMAT, and
// deterministically — the same file must trace the same way on every machine:
//
//   PNG            the harness's own decoder (exact, no re-encode round trip),
//                  falling back to resvg for the interlaced ones it refuses
//   JPEG/GIF/BMP   resvg, by wrapping the bytes in a one-element `<image>` SVG
//   WebP           sharp — resvg's image reader does not know the format, and
//                  silently renders NOTHING rather than failing (which is how
//                  this was found: the repo's own example sheets are WebP)
//   SVG            resvg, rendered at the resolution the tracer asked for
//
// Downscaling to the trace cap is the repo's box-average `downscaleImageData`,
// not resvg's sampler: an area average is what the sheet path was measured on,
// and a bilinear tap at 4:1 would alias the anti-aliasing the tracer reads.

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, extname } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import { decodePng } from '../devtest/png.ts'
import { encodePng } from '../devtest/pngEncode.ts'
import { downscaleImageData } from '../lib/sheet/crop.ts'
import type { ImageDataLike } from '../lib/sheet/types'
import { requireFile } from './runtime.ts'

/** What a source file turned out to be. */
export interface LoadedSource {
  /** Absolute path it came from. */
  path: string
  /** Base name, used to name outputs when the caller gives none. */
  name: string
  kind: 'svg' | 'raster'
  /** SVG markup (vector sources only). */
  svgText: string | null
  /** Raw file bytes (raster sources only). */
  bytes: Uint8Array | null
  mime: string
  /** Intrinsic size — the viewBox for SVG, the pixel grid for a raster. */
  width: number
  height: number
}

const RASTER_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
}

/** Sniff the container from the magic bytes — the extension is a hint, not proof. */
function sniffMime(bytes: Uint8Array, ext: string): string {
  const b = bytes
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif'
  if (b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp'
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45) return 'image/webp'
  return RASTER_MIME[ext] ?? 'application/octet-stream'
}

/** Intrinsic pixel size, read from the container header. */
function rasterSize(bytes: Uint8Array, mime: string): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (mime === 'image/png') {
    // IHDR is always the first chunk: 8-byte signature + 4 length + 4 type.
    return { width: view.getUint32(16), height: view.getUint32(20) }
  }
  if (mime === 'image/gif') {
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) }
  }
  if (mime === 'image/bmp') {
    return { width: view.getInt32(18, true), height: Math.abs(view.getInt32(22, true)) }
  }
  if (mime === 'image/jpeg') {
    // Walk the marker segments to the first start-of-frame.
    let i = 2
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) {
        i++
        continue
      }
      const marker = bytes[i + 1]
      // SOF0..SOF15, minus the non-frame markers DHT (c4), JPGA (c8) and DAC (cc).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: view.getUint16(i + 5), width: view.getUint16(i + 7) }
      }
      i += 2 + view.getUint16(i + 2)
    }
    throw new Error('JPEG has no start-of-frame marker')
  }
  if (mime === 'image/webp') {
    const fourcc = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15])
    if (fourcc === 'VP8X') return { width: 1 + readU24(bytes, 24), height: 1 + readU24(bytes, 27) }
    if (fourcc === 'VP8 ') return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff }
    if (fourcc === 'VP8L') {
      const bits = view.getUint32(21, true)
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
    }
    throw new Error(`unsupported WebP variant ${fourcc}`)
  }
  throw new Error(`cannot read the size of ${mime} — supported: PNG, JPEG, WebP, GIF, BMP, SVG`)
}

function readU24(b: Uint8Array, at: number): number {
  return b[at] | (b[at + 1] << 8) | (b[at + 2] << 16)
}

/** Load an image file (raster or SVG) and report what it is. */
export function loadSource(path: string): LoadedSource {
  const full = requireFile(path, 'image')
  const ext = extname(full).toLowerCase()
  const raw = readFileSync(full)
  const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
  const name = basename(full, extname(full))

  const looksSvg = ext === '.svg' || raw.subarray(0, 512).toString('utf8').trimStart().startsWith('<')
  if (looksSvg) {
    const svgText = raw.toString('utf8')
    // resvg has already parsed width/height/viewBox — no second SVG parser here.
    const probe = new Resvg(svgText)
    return { path: full, name, kind: 'svg', svgText, bytes: null, mime: 'image/svg+xml', width: probe.width, height: probe.height }
  }

  const mime = sniffMime(bytes, ext)
  const { width, height } = rasterSize(bytes, mime)
  return { path: full, name, kind: 'raster', svgText: null, bytes, mime, width, height }
}

/** `data:` URI for embedding a raster source into a composed SVG. */
export function dataUri(src: LoadedSource): string {
  if (src.kind === 'svg') return `data:image/svg+xml;base64,${Buffer.from(src.svgText ?? '', 'utf8').toString('base64')}`
  return `data:${src.mime};base64,${Buffer.from(src.bytes ?? new Uint8Array()).toString('base64')}`
}

/** Render an SVG string to RGBA pixels at a given long-side size. */
export function renderSvg(svgText: string, longSide: number, background?: string): ImageDataLike {
  const probe = new Resvg(svgText)
  const wide = probe.width >= probe.height
  const rendered = new Resvg(svgText, {
    fitTo: wide ? { mode: 'width', value: Math.round(longSide) } : { mode: 'height', value: Math.round(longSide) },
    ...(background ? { background } : {}),
  }).render()
  return { width: rendered.width, height: rendered.height, data: new Uint8ClampedArray(rendered.pixels) }
}

/**
 * The pixels the tracer should see: decoded at native resolution, then box-
 * averaged down to `maxDim` (never up — same contract as the app's getImageData).
 * SVG sources are rendered straight at the cap, which is where their crispness
 * comes from.
 */
export async function rasterizeSource(src: LoadedSource, maxDim: number, background?: string): Promise<ImageDataLike> {
  // An SVG has no native pixels, so the cap IS the resolution it is drawn at.
  if (src.kind === 'svg') return renderSvg(src.svgText ?? '', maxDim, background)

  let native: ImageDataLike
  if (src.mime === 'image/png') {
    try {
      native = decodePng(src.bytes ?? new Uint8Array())
    } catch {
      // Interlaced PNG (the one case the harness decoder refuses) — let resvg do it.
      native = decodeViaResvg(src)
    }
  } else if (src.mime === 'image/webp') {
    native = await decodeViaSharp(src)
  } else {
    native = decodeViaResvg(src)
  }

  const capped = downscaleImageData(native, maxDim)
  return background ? flattenOnto(capped, background) : capped
}

/**
 * sharp, loaded only if a format needs it. It is a devDependency (it already
 * ships as a transitive dep of the AI cutout's runtime), so a checkout that ran
 * `pnpm install` has it; a stripped install gets a message naming the fix rather
 * than a blank image.
 */
type SharpFactory = (input: Uint8Array) => {
  raw: () => { ensureAlpha: () => { toBuffer: (o: { resolveWithObject: true }) => Promise<{ data: Buffer; info: { width: number; height: number } }> } }
}
let sharpCache: SharpFactory | null | undefined
function loadSharp(): SharpFactory {
  if (sharpCache === undefined) {
    try {
      sharpCache = createRequire(import.meta.url)('sharp') as SharpFactory
    } catch {
      sharpCache = null
    }
  }
  if (!sharpCache) {
    throw new Error('This format needs the optional `sharp` decoder. Run `pnpm install` in the LogoLab checkout, or convert the image to PNG first.')
  }
  return sharpCache
}

/** Decode through sharp — the formats resvg cannot read (WebP). */
async function decodeViaSharp(src: LoadedSource): Promise<ImageDataLike> {
  const sharp = loadSharp()
  const { data, info } = await sharp(src.bytes ?? new Uint8Array()).raw().ensureAlpha().toBuffer({ resolveWithObject: true })
  return { width: info.width, height: info.height, data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength) }
}

/** Decode any raster resvg can read by wrapping it in a one-element SVG. */
function decodeViaResvg(src: LoadedSource): ImageDataLike {
  const { width, height } = src
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<image href="${dataUri(src)}" x="0" y="0" width="${width}" height="${height}" preserveAspectRatio="none"/></svg>`
  const rendered = new Resvg(svg, { fitTo: { mode: 'width', value: width } }).render()
  return { width: rendered.width, height: rendered.height, data: new Uint8ClampedArray(rendered.pixels) }
}

/** Composite RGBA over an opaque colour — for tracing art that assumes paper. */
export function flattenOnto(img: ImageDataLike, hex: string): ImageDataLike {
  const [br, bg, bb] = parseHexColor(hex)
  const out = new Uint8ClampedArray(img.data.length)
  for (let i = 0; i < img.data.length; i += 4) {
    const a = img.data[i + 3] / 255
    out[i] = Math.round(img.data[i] * a + br * (1 - a))
    out[i + 1] = Math.round(img.data[i + 1] * a + bg * (1 - a))
    out[i + 2] = Math.round(img.data[i + 2] * a + bb * (1 - a))
    out[i + 3] = 255
  }
  return { width: img.width, height: img.height, data: out }
}

/** `#rgb` / `#rrggbb` → [r, g, b]. Unknown input reads as white. */
export function parseHexColor(hex: string): [number, number, number] {
  const h = hex.trim().replace('#', '')
  if (h.length === 3) return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16)]
  if (h.length >= 6) return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
  return [255, 255, 255]
}

/** Does any pixel carry partial or zero alpha? */
export function hasAlpha(img: ImageDataLike, threshold = 250): boolean {
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i] < threshold) return true
  return false
}

/** Encode RGBA pixels as a PNG (shared with the headless harness's writer). */
export function pngFrom(img: ImageDataLike): Uint8Array {
  return encodePng(img.data, img.width, img.height)
}
