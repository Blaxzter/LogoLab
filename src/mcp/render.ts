// The icon renderer, without a canvas.
//
// The app draws each icon on a 2D context; here the same icon is COMPOSED as an
// SVG (backplate, clip, logo, optional tint/invert filter) and handed to resvg.
// The geometry is not re-derived — `iconLayout` in src/lib/iconSpec.ts is the one
// answer both renderers draw, so an agent's 512px maskable clears Android's mask
// exactly where the UI's does.
//
// A VECTOR logo is nested as a real `<svg>` element, so resvg draws the curves
// analytically at the target size: a 16px favicon off a traced logo is rendered,
// not downsampled. A RASTER logo is box-averaged to roughly twice its destination
// box first — resvg's own sampler is a bilinear tap, which aliases badly at 4:1 —
// and then embedded as a PNG.

import { Resvg } from '@resvg/resvg-js'
import { iconLayout, type RenderIconOpts } from '../lib/iconSpec.ts'
import { downscaleImageData } from '../lib/sheet/crop.ts'
import type { ImageDataLike } from '../lib/sheet/types'
import { pngFrom, rasterizeSource, type LoadedSource } from './image.ts'

/** A logo ready to be placed into any number of icons. */
export interface PreparedLogo {
  kind: 'vector' | 'raster'
  /** Intrinsic aspect — what `iconLayout` fits into the safe box. */
  width: number
  height: number
  /** Markup that draws the logo into the given rect. */
  place: (rect: { x: number; y: number; width: number; height: number }) => string
}

/** Strip anything that cannot legally sit inside another document (XML decl, doctype). */
function innerSvg(svgText: string): string {
  return svgText
    .replace(/<\?xml[\s\S]*?\?>/g, '')
    .replace(/<!DOCTYPE[\s\S]*?>/gi, '')
    .trim()
}

const attr = (n: number): string => String(Number(n.toFixed(3)))

/** A vector logo: nested `<svg>`, positioned by x/y/width/height. */
export function prepareVector(svgText: string, width: number, height: number): PreparedLogo {
  const inner = innerSvg(svgText)
  return {
    kind: 'vector',
    width,
    height,
    place: (r) =>
      inner.replace(
        /<svg\b/,
        `<svg x="${attr(r.x)}" y="${attr(r.y)}" width="${attr(r.width)}" height="${attr(r.height)}" preserveAspectRatio="xMidYMid meet"`,
      ),
  }
}

/**
 * A raster logo. Pixels are resampled per destination size (box average, cached),
 * so a 32px favicon does not come out of a bilinear tap on a 1024px source.
 */
export function prepareRaster(pixels: ImageDataLike): PreparedLogo {
  const cache = new Map<number, string>()
  const uriFor = (longSide: number): string => {
    const capped = Math.min(Math.max(longSide, 1), Math.max(pixels.width, pixels.height))
    // Bucket to powers of two so a 17-target export does not resample 17 times.
    const bucket = Math.min(Math.max(2 ** Math.ceil(Math.log2(capped)), 16), Math.max(pixels.width, pixels.height))
    const hit = cache.get(bucket)
    if (hit) return hit
    const scaled = downscaleImageData(pixels, bucket)
    const uri = `data:image/png;base64,${Buffer.from(pngFrom(scaled)).toString('base64')}`
    cache.set(bucket, uri)
    return uri
  }
  return {
    kind: 'raster',
    width: pixels.width,
    height: pixels.height,
    place: (r) =>
      `<image href="${uriFor(Math.ceil(Math.max(r.width, r.height) * 2))}" x="${attr(r.x)}" y="${attr(r.y)}" ` +
      `width="${attr(r.width)}" height="${attr(r.height)}" preserveAspectRatio="xMidYMid meet"/>`,
  }
}

/** Prepare whatever the caller pointed at: SVG stays vector, rasters get decoded once. */
export async function prepareSource(src: LoadedSource, rasterCap = 1024): Promise<PreparedLogo> {
  if (src.kind === 'svg') return prepareVector(src.svgText ?? '', src.width, src.height)
  return prepareRaster(await rasterizeSource(src, Math.max(rasterCap, 1)))
}

/** Prepare a traced SVG string (the usual path: trace, then export). */
export function prepareTraced(svg: string): PreparedLogo {
  const probe = new Resvg(svg)
  return prepareVector(svg, probe.width, probe.height)
}

/** The backplate outline for a shape, as SVG markup. */
function shapeMarkup(size: number, shape: string, radius: number, fill: string): string {
  if (shape === 'circle') {
    return `<circle cx="${attr(size / 2)}" cy="${attr(size / 2)}" r="${attr(size / 2)}" fill="${fill}"/>`
  }
  const r = Math.max(0, Math.min(radius, size / 2))
  return `<rect x="0" y="0" width="${size}" height="${size}"${r > 0 ? ` rx="${attr(r)}" ry="${attr(r)}"` : ''} fill="${fill}"/>`
}

/** Compose one icon as an SVG document. Exposed for tests and for `--dump-svg`. */
export function composeIcon(logo: PreparedLogo, opts: RenderIconOpts): string {
  const { size, shape, radius, background, fullBleed, content } = iconLayout(opts, logo.width, logo.height)
  const tint = opts.tintColor
  const invert = opts.invert === true

  const defs: string[] = []
  // Clip to the card shape — except full-bleed maskable, which fills the square
  // on purpose so the platform's mask never uncovers a transparent corner.
  if (!fullBleed) {
    defs.push(`<clipPath id="card">${shapeMarkup(size, shape, radius, '#000')}</clipPath>`)
  }
  if (tint) {
    // Recolour through the alpha channel: flood the tint, keep the logo's alpha.
    // (The canvas renderer does the same with a source-in composite.)
    defs.push(
      `<filter id="tint" x="-10%" y="-10%" width="120%" height="120%" color-interpolation-filters="sRGB">` +
        `<feFlood flood-color="${tint}" result="flood"/>` +
        `<feComposite in="flood" in2="SourceAlpha" operator="in"/></filter>`,
    )
  } else if (invert) {
    defs.push(
      `<filter id="invert" x="-10%" y="-10%" width="120%" height="120%" color-interpolation-filters="sRGB">` +
        `<feColorMatrix type="matrix" values="-1 0 0 0 1  0 -1 0 0 1  0 0 -1 0 1  0 0 0 1 0"/></filter>`,
    )
  }

  const body: string[] = []
  if (background !== 'transparent') {
    body.push(
      fullBleed
        ? `<rect x="0" y="0" width="${size}" height="${size}" fill="${background}"/>`
        : shapeMarkup(size, shape, radius, background),
    )
  }
  if (content) {
    const filter = tint ? ' filter="url(#tint)"' : invert ? ' filter="url(#invert)"' : ''
    const clip = fullBleed ? '' : ' clip-path="url(#card)"'
    body.push(`<g${clip}${filter}>${logo.place(content)}</g>`)
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    (defs.length ? `<defs>${defs.join('')}</defs>` : '') +
    body.join('') +
    `</svg>`
  )
}

/** Render one icon to PNG bytes. */
export function renderIconPng(logo: PreparedLogo, opts: RenderIconOpts): Uint8Array {
  const svg = composeIcon(logo, opts)
  const out = new Resvg(svg, { fitTo: { mode: 'width', value: opts.size } }).render()
  return new Uint8Array(out.asPng())
}
