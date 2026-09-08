// PWA / icon export pipeline.
//
// Renders the user's logo into a square icon on a canvas (mirroring the math in
// <LogoMark>), then bundles a complete favicon + PWA icon set into a .zip with a
// real favicon.ico, a webmanifest, and a copy-paste <head> snippet.

import { loadRenderSource } from './image.ts'
import { buildHtmlSnippet, buildManifest, encodeIcoBytes, iconLayout, type RenderIconOpts } from './iconSpec.ts'
import type { ExportTarget, RenderIconOptions } from '../types'

// The catalogue, the maskable safe-zone numbers, the layout math and the text
// assets are SHARED with the headless exporter (src/mcp) and live in iconSpec.ts.
// Re-exported here so the UI's existing imports keep working unchanged.
export {
  DEFAULT_TARGETS,
  MASKABLE_SAFE_DIAMETER,
  MASKABLE_MIN_PADDING_PCT,
  MASKABLE_PADDING_FLOOR_PCT,
  iconLayout,
  buildManifest,
  buildHtmlSnippet,
} from './iconSpec.ts'

export type { RenderIconOpts } from './iconSpec.ts'

/* --------------------------------------------------------------- renderIcon */

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
 * The geometry — backplate shape, safe zone, contain-fit, the maskable clamp —
 * is `iconLayout` (iconSpec.ts), shared with the headless exporter; this
 * function is only the canvas drawing of that answer.
 */
export function renderIcon(
  source: CanvasImageSource,
  srcW: number,
  srcH: number,
  opts: RenderIconOpts,
): HTMLCanvasElement {
  const { tintColor, invert } = opts
  const { size, shape, radius, background, fullBleed, content } = iconLayout(opts, srcW, srcH)

  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = get2d(canvas)

  const drawShapePath = () => {
    if (shape === 'circle') {
      ctx.beginPath()
      ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2)
      ctx.closePath()
    } else {
      roundedRectPath(ctx, size, radius)
    }
  }

  // Fill the card backplate. A maskable icon is full-bleed: paint the entire
  // square so the platform mask never reveals transparent corners.
  if (background !== 'transparent') {
    ctx.save()
    if (fullBleed) {
      ctx.fillStyle = background
      ctx.fillRect(0, 0, size, size)
    } else {
      drawShapePath()
      ctx.fillStyle = background
      ctx.fill()
    }
    ctx.restore()
  }

  // Clip subsequent drawing to the shape (skip for full-bleed maskable, which
  // intentionally fills the whole square).
  ctx.save()
  if (!fullBleed) {
    drawShapePath()
    ctx.clip()
  }

  if (content) {
    const { x: dx, y: dy, width: cw, height: ch } = content
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

/* --------------------------------------------------------------- favicon.ico */

/** The shared .ico container (iconSpec.ts), handed back as a Blob for download. */
export function encodeIco(images: { size: number; png: ArrayBuffer }[]): Blob {
  const bytes = encodeIcoBytes(images.map((i) => ({ size: i.size, png: new Uint8Array(i.png) })))
  return new Blob([bytes], { type: 'image/x-icon' })
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
  // JSZip is 94 kB and nothing needs it until someone actually asks for the
  // bundle, so it is fetched here rather than carried by every page load.
  const { default: JSZip } = await import('jszip')
  // Rasterize SVGs at high resolution so exported icons are crisp (an <img>
  // with only a viewBox would render blank/150px); raster sources pass through.
  const { source, width, height } = await loadRenderSource(src, 1024, meta.svgText ?? null)
  const zip = new JSZip()
  // Deployable assets live under public/ so the bundle drops straight into a
  // Vite / Next / CRA / SvelteKit project's public folder (or any web root) and
  // resolves at /favicon.ico, /manifest.webmanifest, /icons/... — the exact
  // paths the manifest and <head> snippet reference. Docs (README, snippet)
  // stay at the zip root, outside the deployable tree.
  const publicDir = zip.folder('public')
  if (!publicDir) throw new Error('Failed to create public folder')
  const iconsDir = publicDir.folder('icons')
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

  // Real favicon.ico beside the icons, built from the enabled favicon sizes.
  if (faviconPngs.length) {
    faviconPngs.sort((a, b) => a.size - b.size)
    const ico = encodeIco(faviconPngs)
    publicDir.file('favicon.ico', await ico.arrayBuffer())
  }

  if (meta.includeManifest) {
    publicDir.file('manifest.webmanifest', buildManifest(meta.brandName, targets))
  }
  // The <head> snippet and README are reference docs, not deployable assets, so
  // they sit at the zip root rather than inside public/.
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
  lines.push('  public/                    Deployable assets — drop into your web root.')
  if (hasIco) lines.push('    favicon.ico              Multi-size classic favicon.')
  if (meta.includeManifest) lines.push('    manifest.webmanifest     PWA manifest.')
  lines.push('    icons/                   PNG icons in every selected size.')
  if (meta.includeHtml) lines.push('  head-snippet.html          Copy these tags into your <head>.')
  lines.push('')
  lines.push(`  ${enabled.length} icon${enabled.length === 1 ? '' : 's'} exported.`)
  lines.push('')
  lines.push('Setup')
  lines.push('-----')
  lines.push("1. Copy the contents of public/ into your project's public/ folder")
  lines.push('   (Vite, Next.js, CRA, SvelteKit…) — or your web root — so they resolve')
  lines.push('   at /favicon.ico, /manifest.webmanifest and /icons/...')
  lines.push('2. Paste the contents of head-snippet.html into your page <head>.')
  lines.push('')
  lines.push('Maskable icons')
  lines.push('--------------')
  lines.push('  maskable-*.png are full-bleed, opaque icons with extra safe-zone')
  lines.push('  padding so Android can mask them to any shape without clipping your')
  lines.push('  logo. Android only guarantees the centre 72dp of 108dp, so keep')
  lines.push('  important content inside a CIRCLE of ~66% diameter — not a square')
  lines.push('  of ~66% width: corner-filling art sits at the box half-diagonal.')
  return lines.join('\n')
}
