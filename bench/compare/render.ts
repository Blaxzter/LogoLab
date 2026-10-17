// One renderer for every SVG in the comparison: resvg, on white, at exactly w×h.
//
// The ground truth is rendered the way bench/groundTruthRun.ts and the truth gate render it
// (fitTo width, white background). A TRACE is rendered into the same w×h box through its own
// viewBox — tools disagree about the root (VTracer writes width/height and no viewBox,
// Potrace writes `512pt` and a viewBox, StarVector picks a 24- or 100-unit viewBox of its
// own), so the root is rewritten to an explicit width/height/viewBox first and the SVG's own
// preserveAspectRatio decides the fit, as a browser would. `rootTransform` is that same fit
// as an affine, so geometry (traceSvg.ts) lands in the pixels the render painted.

import { Resvg } from '@resvg/resvg-js'
import { decodePng } from '../../src/lib/png/decode.ts'
import { attrs } from '../svgGround.ts'
import type { Affine } from '../../src/lib/path/types.ts'

export interface Raster {
  width: number
  height: number
  data: Uint8ClampedArray
}

/** Authored SVG → the truth raster, exactly as the truth gate makes it. */
export function renderGround(svg: string, res: number): Raster {
  const img = decodePng(new Resvg(svg, { fitTo: { mode: 'width', value: res }, background: 'white' }).render().asPng())
  return { width: img.width, height: img.height, data: img.data as Uint8ClampedArray }
}

export interface NormalizedRoot {
  svg: string
  viewBox: [number, number, number, number]
  /** viewBox units → pixels of the w×h render. */
  toPixels: Affine
}

const ROOT = /<svg\b([^>]*?)(\/?)>/

/** Rewrite the root `<svg>` to width=w height=h with an explicit viewBox. Throws when there is no root. */
export function normalizeRoot(svg: string, w: number, h: number): NormalizedRoot {
  const m = ROOT.exec(svg)
  if (!m) throw new Error('no <svg> root element')
  const a = attrs(m[1])
  const nums = (s: string | undefined): number[] =>
    (s ?? '')
      .trim()
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number)
  let vb = nums(a.viewBox)
  if (vb.length !== 4 || !vb.every(Number.isFinite) || vb[2] <= 0 || vb[3] <= 0) {
    const vw = Number.parseFloat(a.width ?? '')
    const vh = Number.parseFloat(a.height ?? '')
    vb = [0, 0, vw > 0 ? vw : w, vh > 0 ? vh : h]
  }
  const viewBox = vb as [number, number, number, number]
  const keep = m[1].replace(/\s(?:width|height|viewBox)\s*=\s*("[^"]*"|'[^']*')/g, '')
  // resvg refuses a root with no SVG namespace ("document does not have a root node") —
  // even `<svg width.. viewBox..><rect/></svg>` — where cairosvg, which SVG-Bench renders
  // with, is lenient. StarVector's `<svg></svg>` placeholder is the case that hit it: with
  // the namespace it renders as the blank white image SVG-Bench scores it as.
  const ns =
    (a.xmlns ? '' : ' xmlns="http://www.w3.org/2000/svg"') +
    (!a['xmlns:xlink'] && /\bxlink:/.test(svg) ? ' xmlns:xlink="http://www.w3.org/1999/xlink"' : '')
  const tag = `<svg${keep}${ns} width="${w}" height="${h}" viewBox="${viewBox.join(' ')}"${m[2]}>`
  return {
    svg: svg.slice(0, m.index) + tag + svg.slice(m.index + m[0].length),
    viewBox,
    toPixels: fitAffine(viewBox, w, h, a.preserveAspectRatio),
  }
}

/** SVG's preserveAspectRatio (align + meet|slice), as the affine viewBox → viewport. */
export function fitAffine(vb: [number, number, number, number], w: number, h: number, par = ''): Affine {
  const [minX, minY, vw, vh] = vb
  const [align = 'xMidYMid', mode = 'meet'] = par.trim().split(/\s+/)
  if (align === 'none') return [w / vw, 0, 0, h / vh, -minX * (w / vw), -minY * (h / vh)]
  const s = mode === 'slice' ? Math.max(w / vw, h / vh) : Math.min(w / vw, h / vh)
  const fx = align.includes('xMin') ? 0 : align.includes('xMax') ? 1 : 0.5
  const fy = align.includes('YMin') ? 0 : align.includes('YMax') ? 1 : 0.5
  return [s, 0, 0, s, (w - vw * s) * fx - minX * s, (h - vh * s) * fy - minY * s]
}

/** A trace's SVG → RGBA on white at exactly w×h. Throws on anything resvg cannot draw. */
export function renderTrace(svg: string, w: number, h: number): Raster {
  const root = normalizeRoot(svg, w, h)
  const r = new Resvg(root.svg, { background: 'white' }).render()
  if (r.width !== w || r.height !== h) throw new Error(`render is ${r.width}×${r.height}, expected ${w}×${h}`)
  return { width: w, height: h, data: new Uint8ClampedArray(r.pixels) }
}
