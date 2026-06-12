// Potrace (WASM) wrapper: traces one binary mask into editable Bézier
// subpaths. The esm-potrace-wasm module ships a sizeable WASM binary, so it is
// loaded via dynamic import() on first use — nothing here touches the initial
// app bundle.
//
// Potrace emits a full SVG string whose paths sit inside a
// `<g transform="translate(…) scale(…)">` wrapper (the classic potrace
// coordinate system with the Y-flip baked into the transform). We parse that
// document, compose every ancestor transform onto each path, and return the
// flattened subpaths in mask pixel space.

import type { Affine, SubPath } from '../path/types'
import { parsePathD } from '../path/model.ts'
import { composeAffine, parseTransformAttr, transformSubPaths } from '../path/geometry.ts'

/** Per-mask potrace tuning knobs (see traceImage for the user-dial mapping). */
export interface TraceMaskOptions {
  /** Suppress speckles up to this many pixels of area. */
  turdsize: number
  /** Corner threshold: higher = smoother curves, fewer corners (0–1.3334). */
  alphamax: number
  /** Curve-optimization tolerance: higher = fewer, looser segments. */
  opttolerance: number
}

type PotraceModule = typeof import('esm-potrace-wasm')

// PINNED to 0.4.1 (exact): 0.4.2+ were rebuilt with emscripten's new 64 KiB
// default WASM stack, and potrace's ccall marshals the whole RGBA buffer onto
// that stack — any image ≥ ~128×128 dies with "offset is out of bounds".
// 0.4.1 still carries the old 5 MiB stack and handles 1024×1024 fine.
let potracePromise: Promise<PotraceModule> | null = null

/** Load + init the potrace WASM module once, cached for the session. */
function loadPotrace(): Promise<PotraceModule> {
  if (!potracePromise) {
    potracePromise = (async () => {
      const mod = await import('esm-potrace-wasm')
      await mod.init()
      return mod
    })()
    // A failed load shouldn't poison the cache — let the next trace retry.
    potracePromise.catch(() => {
      potracePromise = null
    })
  }
  return potracePromise
}

const IDENTITY: Affine = [1, 0, 0, 1, 0, 0]

/**
 * Trace a binary mask (opaque black shapes on opaque white) into one compound
 * path's subpaths, in mask pixel coordinates. Returns [] for a blank mask or
 * unparseable tracer output — normal for tiny layers, not an error.
 */
export async function traceMask(mask: ImageData, opts: TraceMaskOptions): Promise<SubPath[]> {
  const { potrace } = await loadPotrace()
  const svg = await potrace(mask, {
    turdsize: opts.turdsize,
    turnpolicy: 4,
    alphamax: opts.alphamax,
    opticurve: 1,
    opttolerance: opts.opttolerance,
    // pathonly would split compound paths on 'M', destroying holes — keep the
    // full SVG document and flatten its transforms instead.
    pathonly: false,
    extractcolors: false,
    posterizelevel: 1,
    posterizationalgorithm: 0,
  })
  return svgToSubPaths(svg)
}

/** Flatten every <path> in an SVG string into bare subpaths in pixel space. */
function svgToSubPaths(svg: string): SubPath[] {
  try {
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
    if (doc.querySelector('parsererror')) return []

    const out: SubPath[] = []
    for (const path of doc.querySelectorAll('path')) {
      const d = path.getAttribute('d')
      if (!d || !d.trim()) continue

      // Collect transforms from the path up through its <g> ancestors, then
      // compose top-down (outermost applied last in composeAffine terms).
      const chain: Affine[] = []
      for (
        let el: Element | null = path;
        el && el.tagName.toLowerCase() !== 'svg';
        el = el.parentElement
      ) {
        chain.push(parseTransformAttr(el.getAttribute('transform')))
      }
      let m = IDENTITY
      for (let i = chain.length - 1; i >= 0; i--) m = composeAffine(m, chain[i])

      out.push(...transformSubPaths(parsePathD(d), m))
    }
    return out
  } catch {
    return []
  }
}
