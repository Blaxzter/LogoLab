// Browser SVG rasterization via @resvg/resvg-wasm — the SAME Rust `resvg` engine the
// Node gate (@resvg/resvg-js) and the snapshot writer use, so the labs rasterize
// pixel-for-pixel identically to CI. The alternative, the browser's own canvas SVG
// renderer, is a DIFFERENT engine (Blink's), which is exactly why the lab and the CLI
// used to disagree about real numbers — docs/labs.md rule 3 (bloom read 3/7 regions in
// the lab vs 5/7 in the CLI). Verified byte-identical to resvg-js 2.6.2 across flat and
// gradient corpus cases before adopting (0 differing pixels, maxΔ 0).
//
// The WASM (~1 MB) is lazily imported and initialized ONCE, only when a lab first
// rasterizes an SVG, so it never enters the product bundle — the labs are already lazy
// routes (docs/labs.md rule 4), and the product's own SVG path (lib/image.getImageData,
// canvas) is deliberately left untouched.

import { getImageData } from '../../lib/image'

// initWasm may be called only once per page; a singleton promise guards that and lets
// concurrent callers await the same initialization.
let resvgMod: Promise<typeof import('@resvg/resvg-wasm')> | null = null

async function loadResvg(): Promise<typeof import('@resvg/resvg-wasm')> {
  if (!resvgMod) {
    resvgMod = (async () => {
      const mod = await import('@resvg/resvg-wasm')
      const wasmUrl = (await import('@resvg/resvg-wasm/index_bg.wasm?url')).default
      await mod.initWasm(fetch(wasmUrl))
      return mod
    })()
  }
  return resvgMod
}

/**
 * Rasterize SVG markup to ImageData with resvg-wasm, matching the Node consumers'
 * call exactly: fit the WIDTH to `width` px (the truth gate and the snapshot writer
 * both use mode:'width'), with an optional solid `background`. `.pixels` is raw RGBA,
 * so there is no PNG round-trip.
 */
export async function rasterizeSvgResvg(
  svgText: string,
  width: number,
  opts?: { background?: string },
): Promise<ImageData> {
  const { Resvg } = await loadResvg()
  const r = new Resvg(svgText, {
    fitTo: { mode: 'width', value: Math.max(1, Math.round(width)) },
    ...(opts?.background ? { background: opts.background } : {}),
  })
  const rendered = r.render()
  const w = rendered.width
  const h = rendered.height
  // Copy out of WASM memory into an ImageData-owned buffer before freeing both handles.
  const px = new Uint8ClampedArray(rendered.pixels.length)
  px.set(rendered.pixels)
  rendered.free()
  r.free()
  return new ImageData(px, w, h)
}

/**
 * Drop-in for lib/image.getImageData, for the LABS. SVG markup is rasterized with
 * resvg-wasm (identical to CI); a raster URL (PNG, no svgText) falls through to the
 * product's canvas path — PNG *decode* is a separate, far smaller divergence and not
 * what this addresses. `background` (SVG only) matches the consumer: the truth gate
 * composites on white, the snapshot writer and the product leave it transparent.
 */
export async function labImageData(
  src: string,
  maxDim: number,
  svgText?: string | null,
  opts?: { background?: string },
): Promise<ImageData> {
  if (svgText) return rasterizeSvgResvg(svgText, maxDim, opts)
  return getImageData(src, maxDim)
}
