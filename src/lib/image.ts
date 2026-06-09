// Image loading & pixel utilities shared by the vectorize and export pipelines.

import type { LogoAsset } from '../types'

export interface LoadedImage extends Partial<LogoAsset> {
  src: string
}

/** Read an uploaded File into a LogoAsset patch (object URL + metadata). */
export async function loadLogoFile(file: File): Promise<LoadedImage> {
  const isSvg = file.type === 'image/svg+xml' || /\.svg$/i.test(file.name)

  if (isSvg) {
    const svgText = await file.text()
    const blob = new Blob([svgText], { type: 'image/svg+xml' })
    const src = URL.createObjectURL(blob)
    const { width, height } = parseSvgSize(svgText)
    return {
      src,
      originalSrc: src,
      fileName: file.name,
      mime: 'image/svg+xml',
      isSvg: true,
      svgText,
      naturalWidth: width,
      naturalHeight: height,
    }
  }

  const src = URL.createObjectURL(file)
  const img = await loadImageElement(src)
  return {
    src,
    originalSrc: src,
    fileName: file.name,
    mime: file.type || 'image/png',
    isSvg: false,
    svgText: null,
    naturalWidth: img.naturalWidth,
    naturalHeight: img.naturalHeight,
  }
}

/** Best-effort extraction of intrinsic size from raw SVG markup. */
export function parseSvgSize(svgText: string): { width: number; height: number } {
  try {
    const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml')
    const svg = doc.querySelector('svg')
    if (svg) {
      const vb = svg.getAttribute('viewBox')
      if (vb) {
        const parts = vb.split(/[\s,]+/).map(Number)
        if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
          return { width: parts[2], height: parts[3] }
        }
      }
      const w = parseFloat(svg.getAttribute('width') || '')
      const h = parseFloat(svg.getAttribute('height') || '')
      if (w > 0 && h > 0) return { width: w, height: h }
    }
  } catch {
    /* fall through */
  }
  return { width: 512, height: 512 }
}

export function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Failed to load image'))
    img.src = src
  })
}

/**
 * Rasterize any image source to ImageData, scaled so its largest side fits
 * `maxDim`. When `svgText` is supplied the SVG is rasterized crisply at the
 * target resolution (an <img> with only a viewBox otherwise defaults to 150px).
 */
export async function getImageData(
  src: string,
  maxDim = 512,
  svgText?: string | null,
): Promise<ImageData> {
  if (svgText) return rasterizeSvgText(svgText, maxDim)

  const img = await loadImageElement(src)
  let w = img.naturalWidth || maxDim
  let h = img.naturalHeight || maxDim
  const longest = Math.max(w, h)
  if (longest > maxDim) {
    const k = maxDim / longest
    w = Math.round(w * k)
    h = Math.round(h * k)
  }
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('Canvas 2D context unavailable')
  ctx.drawImage(img, 0, 0, w, h)
  return ctx.getImageData(0, 0, w, h)
}

/** Force explicit pixel dimensions on an SVG root (keeps/derives a viewBox). */
function ensureSvgSize(svgText: string, w: number, h: number): string {
  try {
    const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml')
    const svg = doc.querySelector('svg')
    if (!svg) return svgText
    if (!svg.getAttribute('viewBox')) {
      const ow = parseFloat(svg.getAttribute('width') || '')
      const oh = parseFloat(svg.getAttribute('height') || '')
      if (ow > 0 && oh > 0) svg.setAttribute('viewBox', `0 0 ${ow} ${oh}`)
    }
    svg.setAttribute('width', String(w))
    svg.setAttribute('height', String(h))
    return new XMLSerializer().serializeToString(svg)
  } catch {
    return svgText
  }
}

/** Rasterize SVG markup crisply at `maxDim` into a canvas (forces explicit size). */
async function rasterizeSvgToCanvas(
  svgText: string,
  maxDim: number,
): Promise<{ canvas: HTMLCanvasElement; width: number; height: number }> {
  const { width, height } = parseSvgSize(svgText)
  const longest = Math.max(width, height) || maxDim
  const k = maxDim / longest
  const w = Math.max(1, Math.round(width * k))
  const h = Math.max(1, Math.round(height * k))
  const sized = ensureSvgSize(svgText, w, h)
  const url = URL.createObjectURL(new Blob([sized], { type: 'image/svg+xml' }))
  try {
    const img = await loadImageElement(url)
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new Error('Canvas 2D context unavailable')
    ctx.drawImage(img, 0, 0, w, h)
    return { canvas, width: w, height: h }
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }
}

async function rasterizeSvgText(svgText: string, maxDim: number): Promise<ImageData> {
  const { canvas, width, height } = await rasterizeSvgToCanvas(svgText, maxDim)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('Canvas 2D context unavailable')
  return ctx.getImageData(0, 0, width, height)
}

/** A drawable source plus its true intrinsic pixel dimensions. */
export interface RenderSource {
  source: CanvasImageSource
  width: number
  height: number
}

/**
 * Load a logo as a drawable canvas source with reliable dimensions. SVGs are
 * rasterized at `maxDim` (an <img> with only a viewBox would otherwise report
 * 0/150px), so callers like the export pipeline always get crisp, correctly
 * proportioned pixels.
 */
export async function loadRenderSource(
  src: string,
  maxDim = 1024,
  svgText?: string | null,
): Promise<RenderSource> {
  if (svgText) {
    const { canvas, width, height } = await rasterizeSvgToCanvas(svgText, maxDim)
    return { source: canvas, width, height }
  }
  const img = await loadImageElement(src)
  return { source: img, width: img.naturalWidth || maxDim, height: img.naturalHeight || maxDim }
}

export interface TrimResult {
  imageData: ImageData
  /** Bounding box of opaque content within the original. */
  bounds: { x: number; y: number; width: number; height: number }
  /** True if any opaque pixel was found. */
  hasContent: boolean
}

/** Crop transparent margins around the opaque content of an ImageData. */
export function trimTransparent(imageData: ImageData, alphaThreshold = 8): TrimResult {
  const { data, width, height } = imageData
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = data[(y * width + x) * 4 + 3]
      if (alpha > alphaThreshold) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }

  if (maxX < 0) {
    return {
      imageData,
      bounds: { x: 0, y: 0, width, height },
      hasContent: false,
    }
  }

  const bw = maxX - minX + 1
  const bh = maxY - minY + 1
  const out = new ImageData(bw, bh)
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const si = ((y + minY) * width + (x + minX)) * 4
      const di = (y * bw + x) * 4
      out.data[di] = data[si]
      out.data[di + 1] = data[si + 1]
      out.data[di + 2] = data[si + 2]
      out.data[di + 3] = data[si + 3]
    }
  }
  return {
    imageData: out,
    bounds: { x: minX, y: minY, width: bw, height: bh },
    hasContent: true,
  }
}

export function imageDataToCanvas(imageData: ImageData): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = imageData.width
  canvas.height = imageData.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D context unavailable')
  ctx.putImageData(imageData, 0, 0)
  return canvas
}

export function canvasToBlob(canvas: HTMLCanvasElement, type = 'image/png', quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('canvas.toBlob returned null'))),
      type,
      quality,
    )
  })
}

/** Detect whether an image has any transparency (useful for export hints). */
export function hasAlpha(imageData: ImageData, threshold = 250): boolean {
  const { data } = imageData
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < threshold) return true
  }
  return false
}
