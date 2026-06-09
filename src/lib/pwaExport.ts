// PWA / icon export pipeline.
//
// Renders the user's logo into a square icon on a canvas (mirroring the math in
// <LogoMark>), then bundles a complete favicon + PWA icon set into a .zip with a
// real favicon.ico, a webmanifest, and a copy-paste <head> snippet.

import JSZip from 'jszip'
import { loadRenderSource } from './image'
import type { ExportTarget, RenderIconOptions, IconShape } from '../types'

/**
 * RenderIconOptions plus the per-target `maskable` flag. Kept local so we don't
 * touch the shared types: maskable is a property of the *output target*, not of
 * the base appearance the user configures.
 */
export type RenderIconOpts = RenderIconOptions & { maskable?: boolean }

/* ----------------------------------------------------------- default targets */

/**
 * The full catalogue of export targets the UI offers. `enabled` here is the
 * sensible default; the panel lets the user toggle individual entries and apply
 * presets on top of this list.
 */
export const DEFAULT_TARGETS: ExportTarget[] = [
  // Favicon — classic multi-size .ico is assembled from these PNGs.
  { id: 'favicon-16', label: 'Favicon 16', size: 16, fileName: 'favicon-16.png', maskable: false, group: 'favicon', enabled: true },
  { id: 'favicon-32', label: 'Favicon 32', size: 32, fileName: 'favicon-32.png', maskable: false, group: 'favicon', enabled: true },
  { id: 'favicon-48', label: 'Favicon 48', size: 48, fileName: 'favicon-48.png', maskable: false, group: 'favicon', enabled: true },

  // Apple touch icons.
  { id: 'apple-180', label: 'Apple touch 180', size: 180, fileName: 'apple-touch-icon.png', maskable: false, group: 'apple', enabled: true },
  { id: 'apple-167', label: 'Apple touch 167', size: 167, fileName: 'apple-touch-icon-167.png', maskable: false, group: 'apple', enabled: false },
  { id: 'apple-152', label: 'Apple touch 152', size: 152, fileName: 'apple-touch-icon-152.png', maskable: false, group: 'apple', enabled: false },
  { id: 'apple-120', label: 'Apple touch 120', size: 120, fileName: 'apple-touch-icon-120.png', maskable: false, group: 'apple', enabled: false },

  // Android / PWA (purpose "any").
  { id: 'android-192', label: 'Android 192', size: 192, fileName: 'icon-192.png', maskable: false, group: 'android', enabled: true },
  { id: 'android-512', label: 'Android 512', size: 512, fileName: 'icon-512.png', maskable: false, group: 'android', enabled: true },
  { id: 'android-96', label: 'Android 96', size: 96, fileName: 'icon-96.png', maskable: false, group: 'android', enabled: false },
  { id: 'android-144', label: 'Android 144', size: 144, fileName: 'icon-144.png', maskable: false, group: 'android', enabled: false },
  { id: 'android-256', label: 'Android 256', size: 256, fileName: 'icon-256.png', maskable: false, group: 'android', enabled: false },
  { id: 'android-384', label: 'Android 384', size: 384, fileName: 'icon-384.png', maskable: false, group: 'android', enabled: false },

  // Maskable (purpose "maskable") — full-bleed, opaque, extra safe-zone.
  { id: 'maskable-192', label: 'Maskable 192', size: 192, fileName: 'maskable-192.png', maskable: true, group: 'maskable', enabled: true },
  { id: 'maskable-512', label: 'Maskable 512', size: 512, fileName: 'maskable-512.png', maskable: true, group: 'maskable', enabled: true },

  // Windows tiles.
  { id: 'windows-150', label: 'Windows tile 150', size: 150, fileName: 'mstile-150.png', maskable: false, group: 'windows', enabled: false },
  { id: 'windows-310', label: 'Windows tile 310', size: 310, fileName: 'mstile-310.png', maskable: false, group: 'windows', enabled: false },
]

/* --------------------------------------------------------------- renderIcon */

/** Compute the corner radius (px) for a shape at a given canvas size. */
function radiusForShape(shape: IconShape, size: number, radiusPct: number): number {
  if (shape === 'circle') return size / 2
  if (shape === 'square') return 0
  return (size * radiusPct) / 100
}

/** Trace a rounded-rectangle path (radius is clamped to half the size). */
function roundedRectPath(ctx: CanvasRenderingContext2D, size: number, radius: number): void {
  const r = Math.max(0, Math.min(radius, size / 2))
  ctx.beginPath()
  ctx.moveTo(r, 0)
  ctx.lineTo(size - r, 0)
  ctx.arcTo(size, 0, size, r, r)
  ctx.lineTo(size, size - r)
  ctx.arcTo(size, size, size - r, size, r)
  ctx.lineTo(r, size)
  ctx.arcTo(0, size, 0, size - r, r)
  ctx.lineTo(0, r)
  ctx.arcTo(0, 0, r, 0, r)
  ctx.closePath()
}

function get2d(canvas: HTMLCanvasElement, willReadFrequently = false): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d', willReadFrequently ? { willReadFrequently: true } : undefined)
  if (!ctx) throw new Error('Canvas 2D context unavailable')
  return ctx
}

/**
 * Render a drawable `source` (with its true intrinsic `srcW`x`srcH`) into a
 * square icon canvas of `opts.size`.
 *
 * Mirrors <LogoMark>: a (optional) colored card backplate clipped to the shape,
 * with the logo drawn `contain` inside a safe-zone inset. Maskable icons are
 * forced opaque and full-bleed with an enlarged safe-zone so content survives
 * the platform's circular/squircle mask.
 */
export function renderIcon(
  source: CanvasImageSource,
  srcW: number,
  srcH: number,
  opts: RenderIconOpts,
): HTMLCanvasElement {
  const { size, shape, radiusPct, scale, tintColor, invert } = opts
  const maskable = opts.maskable === true

  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = get2d(canvas)

  const radius = radiusForShape(shape, size, radiusPct)

  // Background. Maskable icons must be opaque & full-bleed, so when the user
  // chose "transparent" we substitute white.
  let bg = opts.background
  if (maskable && bg === 'transparent') bg = '#ffffff'

  const drawShapePath = () => {
    if (shape === 'circle') {
      ctx.beginPath()
      ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2)
      ctx.closePath()
    } else {
      roundedRectPath(ctx, size, radius)
    }
  }

  // Fill the card backplate.
  if (bg !== 'transparent') {
    ctx.save()
    if (maskable) {
      // Full-bleed: paint the entire square so the platform mask never reveals
      // transparent corners.
      ctx.fillStyle = bg
      ctx.fillRect(0, 0, size, size)
    } else {
      drawShapePath()
      ctx.fillStyle = bg
      ctx.fill()
    }
    ctx.restore()
  }

  // Clip subsequent drawing to the shape (skip for full-bleed maskable, which
  // intentionally fills the whole square).
  ctx.save()
  if (!maskable) {
    drawShapePath()
    ctx.clip()
  }

  // Safe-zone inset. Maskable needs a larger margin so content stays within the
  // ~80% center "safe zone".
  const effPaddingPct = maskable ? Math.max(opts.paddingPct, 18) : opts.paddingPct
  const inset = (size * effPaddingPct) / 100
  const box = Math.max(0, (size - inset * 2) * scale)

  if (box > 0 && srcW > 0 && srcH > 0) {
    // Contain: preserve aspect ratio inside the box.
    const ar = srcW / srcH
    let cw = box
    let ch = box
    if (ar >= 1) ch = box / ar
    else cw = box * ar
    const dx = (size - cw) / 2
    const dy = (size - ch) / 2

    if (tintColor) {
      // Recolor via an offscreen alpha mask: draw logo, then source-in fill.
      const off = document.createElement('canvas')
      off.width = Math.max(1, Math.round(cw))
      off.height = Math.max(1, Math.round(ch))
      const octx = get2d(off, true)
      if (invert) octx.filter = 'invert(1)'
      octx.drawImage(source, 0, 0, off.width, off.height)
      octx.filter = 'none'
      octx.globalCompositeOperation = 'source-in'
      octx.fillStyle = tintColor
      octx.fillRect(0, 0, off.width, off.height)
      ctx.drawImage(off, dx, dy, cw, ch)
    } else {
      if (invert) ctx.filter = 'invert(1)'
      ctx.drawImage(source, dx, dy, cw, ch)
      ctx.filter = 'none'
    }
  }

  ctx.restore()
  return canvas
}

/* ------------------------------------------------------------- manifest/html */

const THEME_COLOR = '#5b5bd6'
const BACKGROUND_COLOR = '#ffffff'

interface ManifestIcon {
  src: string
  sizes: string
  type: string
  purpose?: string
}

/**
 * Build a webmanifest JSON string. Includes every enabled android (purpose
 * "any") and maskable (purpose "maskable") icon.
 */
export function buildManifest(brandName: string, targets: ExportTarget[]): string {
  const name = brandName.trim() || 'App'
  const icons: ManifestIcon[] = targets
    .filter((t) => t.enabled && (t.group === 'android' || t.group === 'maskable'))
    .map((t) => ({
      src: `icons/${t.fileName}`,
      sizes: `${t.size}x${t.size}`,
      type: 'image/png',
      purpose: t.maskable ? 'maskable' : 'any',
    }))

  const manifest = {
    name,
    short_name: name.length > 12 ? name.slice(0, 12) : name,
    icons,
    theme_color: THEME_COLOR,
    background_color: BACKGROUND_COLOR,
    display: 'standalone',
    start_url: '/',
    scope: '/',
  }
  return JSON.stringify(manifest, null, 2)
}

/** Build a copy-paste-friendly <head> snippet wiring up the exported assets. */
export function buildHtmlSnippet(targets: ExportTarget[]): string {
  const lines: string[] = []
  lines.push('<!-- Generated by LogoLab — paste inside <head> -->')

  // Classic favicon (.ico) is always emitted alongside the PNG set.
  lines.push('<link rel="icon" href="/favicon.ico" sizes="any">')

  const favicons = targets.filter((t) => t.enabled && t.group === 'favicon')
  for (const t of favicons) {
    lines.push(`<link rel="icon" type="image/png" sizes="${t.size}x${t.size}" href="/icons/${t.fileName}">`)
  }

  const apple = targets.filter((t) => t.enabled && t.group === 'apple')
  for (const t of apple) {
    // The primary 180px icon uses no sizes attribute (the default).
    const sizesAttr = t.size === 180 ? '' : ` sizes="${t.size}x${t.size}"`
    lines.push(`<link rel="apple-touch-icon"${sizesAttr} href="/icons/${t.fileName}">`)
  }

  lines.push('<link rel="manifest" href="/manifest.webmanifest">')
  lines.push(`<meta name="theme-color" content="${THEME_COLOR}">`)

  const windows = targets.filter((t) => t.enabled && t.group === 'windows')
  for (const t of windows) {
    lines.push(`<meta name="msapplication-TileImage" content="/icons/${t.fileName}">`)
  }
  if (windows.length) {
    lines.push(`<meta name="msapplication-TileColor" content="${THEME_COLOR}">`)
  }

  return lines.join('\n')
}

/* ----------------------------------------------------------------- favicon.ico */

/**
 * Assemble a real .ico file embedding PNG payloads (PNG-in-ICO is valid per the
 * Windows spec and supported by all modern browsers).
 *
 * Layout: ICONDIR (6 bytes) + n × ICONDIRENTRY (16 bytes) + PNG payloads.
 */
export function encodeIco(images: { size: number; png: ArrayBuffer }[]): Blob {
  const count = images.length
  const headerSize = 6
  const entrySize = 16
  const offsetBase = headerSize + entrySize * count

  const header = new ArrayBuffer(offsetBase)
  const view = new DataView(header)

  // ICONDIR
  view.setUint16(0, 0, true) // reserved
  view.setUint16(2, 1, true) // type: 1 = icon
  view.setUint16(4, count, true) // image count

  let offset = offsetBase
  const payloads: ArrayBuffer[] = []

  images.forEach((img, i) => {
    const entryAt = headerSize + entrySize * i
    // ICONDIRENTRY. 256px is encoded as 0.
    const dim = img.size >= 256 ? 0 : img.size
    view.setUint8(entryAt + 0, dim) // width
    view.setUint8(entryAt + 1, dim) // height
    view.setUint8(entryAt + 2, 0) // palette count
    view.setUint8(entryAt + 3, 0) // reserved
    view.setUint16(entryAt + 4, 1, true) // color planes
    view.setUint16(entryAt + 6, 32, true) // bits per pixel
    view.setUint32(entryAt + 8, img.png.byteLength, true) // bytes in resource
    view.setUint32(entryAt + 12, offset, true) // offset of PNG data

    payloads.push(img.png)
    offset += img.png.byteLength
  })

  return new Blob([header, ...payloads], { type: 'image/x-icon' })
}

/* ------------------------------------------------------------- buildExportZip */

function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('canvas.toBlob returned null'))),
      'image/png',
    )
  })
}

/**
 * Render every enabled target, bundle the PNGs, a real favicon.ico, an optional
 * manifest + HTML snippet, and a README into a .zip blob.
 */
export async function buildExportZip(
  src: string,
  targets: ExportTarget[],
  base: Omit<RenderIconOptions, 'size' | 'maskable'>,
  meta: {
    brandName: string
    includeManifest: boolean
    includeHtml: boolean
    svgText?: string | null
  },
): Promise<Blob> {
  // Rasterize SVGs at high resolution so exported icons are crisp (an <img>
  // with only a viewBox would render blank/150px); raster sources pass through.
  const { source, width, height } = await loadRenderSource(src, 1024, meta.svgText ?? null)
  const zip = new JSZip()
  const iconsDir = zip.folder('icons')
  if (!iconsDir) throw new Error('Failed to create icons folder')

  const enabled = targets.filter((t) => t.enabled)

  // Collect favicon PNGs for the .ico in size order (16, 32, 48 ...).
  const faviconPngs: { size: number; png: ArrayBuffer }[] = []

  for (const target of enabled) {
    // Per-target shape: keep the base shape (a circle card is preserved only
    // when the user explicitly chose it).
    const canvas = renderIcon(source, width, height, {
      ...base,
      shape: base.shape,
      size: target.size,
      maskable: target.maskable,
    })
    const blob = await canvasToPngBlob(canvas)
    const buffer = await blob.arrayBuffer()
    iconsDir.file(target.fileName, buffer)

    if (target.group === 'favicon') {
      faviconPngs.push({ size: target.size, png: buffer })
    }
  }

  // Real favicon.ico at the zip root, built from the enabled favicon sizes.
  if (faviconPngs.length) {
    faviconPngs.sort((a, b) => a.size - b.size)
    const ico = encodeIco(faviconPngs)
    zip.file('favicon.ico', await ico.arrayBuffer())
  }

  if (meta.includeManifest) {
    zip.file('manifest.webmanifest', buildManifest(meta.brandName, targets))
  }
  if (meta.includeHtml) {
    zip.file('head-snippet.html', buildHtmlSnippet(targets))
  }

  zip.file('README.txt', buildReadme(meta, enabled, faviconPngs.length > 0))

  return zip.generateAsync({ type: 'blob' })
}

function buildReadme(
  meta: { brandName: string; includeManifest: boolean; includeHtml: boolean },
  enabled: ExportTarget[],
  hasIco: boolean,
): string {
  const lines: string[] = []
  lines.push(`${meta.brandName.trim() || 'App'} — icon set`)
  lines.push('Generated by LogoLab.')
  lines.push('')
  lines.push('Contents')
  lines.push('--------')
  if (hasIco) lines.push('  favicon.ico            Multi-size classic favicon (place at site root).')
  lines.push('  icons/                 PNG icons in every selected size.')
  if (meta.includeManifest) lines.push('  manifest.webmanifest   PWA manifest (place at site root).')
  if (meta.includeHtml) lines.push('  head-snippet.html      Copy these tags into your <head>.')
  lines.push('')
  lines.push(`  ${enabled.length} icon${enabled.length === 1 ? '' : 's'} exported.`)
  lines.push('')
  lines.push('Setup')
  lines.push('-----')
  lines.push('1. Copy favicon.ico, manifest.webmanifest and the icons/ folder to your')
  lines.push('   site root (so they resolve at /favicon.ico, /manifest.webmanifest,')
  lines.push('   /icons/...).')
  lines.push('2. Paste the contents of head-snippet.html into your page <head>.')
  lines.push('')
  lines.push('Maskable icons')
  lines.push('--------------')
  lines.push('  maskable-*.png are full-bleed, opaque icons with extra safe-zone')
  lines.push('  padding so Android can mask them to any shape without clipping your')
  lines.push('  logo. Keep important content within the central ~80%.')
  return lines.join('\n')
}
