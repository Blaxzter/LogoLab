// In-browser AI super-resolution in front of the tracer — waifu2x swin_unet (nunif),
// run through onnxruntime-web, lazy-loaded. Measured: docs/vectorization-benchmarks.md §32.
//
// Why THIS model and not the one that looks best: on the authored answer sheet it halves
// plain bilinear's outline error on small rasters (chamfer 0.09 vs 0.17 at 256 px, 0.25 vs
// 0.47 at 128) while recovering more authored corners (529/564 vs 364) and inventing fewer
// (23 vs 47), because it emits a nearly hard edge between the two EXACT source colours —
// the input the palette stage and the corner detector were built for. Real-ESRGAN, whose
// output looks nicer, repaints every flat colour (ΔE ~2.5) and draws a dark rim inside each
// edge that the palette stage slivers into hundreds of nodes (§32.4). Where it does NOT
// help: the icon-sheet path (mono — bilinear ×4 ties it at 1/300 the cost, so the sheet
// keeps its plain upscale) and anything above ~300 px, where the lattice error is already
// below what anyone can see. Hence `aiUpscaleFactor` returns 0 there and the option is inert.
//
// Same rules as aiRemove.ts: nothing lands in the initial bundle — the runtime
// (onnxruntime-web, script + WASM) is imported from the CDN on first use, the same host
// transformers.js fetches its copy from; the weights (17 / 19 MB, MIT) come from the
// Hugging Face Hub — the `no-referrer` meta in index.html is what gets past the Hub's
// hotlink protection — and are kept in the browser's Cache API. Not a bundled dependency
// on purpose: importing `onnxruntime-web` made Vite emit its 13 MB + 24 MB WASM binaries
// into dist/assets (the deploy has a 25 MiB per-file limit) for files the runtime never
// reads once `wasmPaths` points at the CDN. WASM only: WebGPU support in onnxruntime-web
// is real but the adapter was refused on the machine this was measured on, and 2–5 s
// single-threaded for a 160–256 px image is the budget the option was accepted at.
//
// The model boundary is the one loosely-typed spot here (the ORT session API), isolated.

import { upscaleImageData } from './sheet/crop.ts'

export type UpscaleFactor = 2 | 4

export interface UpscaleProgress {
  /** 'download' while fetching the weights (first use only), 'process' during inference. */
  phase: 'download' | 'process'
  /** 0–100 download percentage (download phase, when the server says the size). */
  percent?: number
  factor: UpscaleFactor
}

/**
 * Rasters longer than this are traced as-is: at 512 px the tracer's own lattice error is
 * already 0.1 px of art, and the answer sheet stops showing a gain (§32.3). Also the time
 * budget — inference scales with the OUTPUT area.
 */
export const AI_UPSCALE_MAX_PX = 320
/**
 * Below this, ×4; from here to the max, ×2. At 128 px the ×4 model recovered 476 authored
 * corners to the ×2 model's 331; at 256 they are within noise of each other and ×2 invents
 * fewer (16 vs 23) — the factor follows the raster toward ~512 px, as the sheet's
 * `traceScale` does.
 */
const X4_BELOW_PX = 160

/** Which factor a raster of this long side gets — 0 means "leave it alone". */
export function aiUpscaleFactor(longSide: number): UpscaleFactor | 0 {
  if (!(longSide > 0) || longSide > AI_UPSCALE_MAX_PX) return 0
  return longSide < X4_BELOW_PX ? 4 : 2
}

const HUB = 'https://huggingface.co/deepghs/waifu2x_onnx/resolve/main/20250502/onnx_models/swin_unet/art'
const MODEL_URL: Record<UpscaleFactor, string> = { 2: `${HUB}/scale2x.onnx`, 4: `${HUB}/scale4x.onnx` }
/** The swin_unet export eats this many input px per side … */
const BORDER = 8
/** … and only accepts sizes that are a multiple of this. Both found by probing (§32.1). */
const MULTIPLE = 64
const CACHE_NAME = 'logolab-models'
/**
 * The onnxruntime-web build to load. Pinned to the version @huggingface/transformers
 * depends on (see pnpm-lock.yaml), so both AI features share one cached WASM download.
 */
const ORT_WEB_VERSION = '1.26.0-dev.20260416-b7804b056c'
const ORT_CDN = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_WEB_VERSION}/dist/`

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ort = any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Session = any

let ortPromise: Promise<Ort> | null = null
const sessionPromises: Partial<Record<UpscaleFactor, Promise<Session>>> = {}

async function loadOrt(): Promise<Ort> {
  if (!ortPromise) {
    ortPromise = (async () => {
      // Script and WASM from the CDN, nothing bundled (see the header).
      const ort: Ort = await import(/* @vite-ignore */ `${ORT_CDN}ort.wasm.min.mjs`)
      ort.env.wasm.wasmPaths = ORT_CDN
      // Threads need cross-origin isolation (COOP/COEP); without it ORT falls back to one
      // thread and warns — say so up front instead.
      ort.env.wasm.numThreads = globalThis.crossOriginIsolated
        ? Math.min(4, navigator.hardwareConcurrency || 1)
        : 1
      return ort
    })()
    ortPromise.catch(() => {
      ortPromise = null
    })
  }
  return ortPromise
}

/** Fetch the weights once; the Cache API keeps them across sessions where it is available. */
async function fetchWeights(
  url: string,
  factor: UpscaleFactor,
  onProgress?: (p: UpscaleProgress) => void,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  let cache: Cache | null = null
  try {
    cache = await caches.open(CACHE_NAME)
    const hit = await cache.match(url)
    if (hit) return hit.arrayBuffer()
  } catch {
    cache = null
  }
  const res = await fetch(url, { signal })
  if (!res.ok || !res.body) throw new Error(`upscaler weights: HTTP ${res.status}`)
  const total = Number(res.headers.get('content-length')) || 0
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let loaded = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    loaded += value.byteLength
    onProgress?.({ phase: 'download', percent: total ? Math.min(100, Math.round((loaded / total) * 100)) : undefined, factor })
  }
  const bytes = new Uint8Array(loaded)
  let o = 0
  for (const c of chunks) {
    bytes.set(c, o)
    o += c.byteLength
  }
  if (cache) {
    try {
      await cache.put(url, new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } }))
    } catch {
      /* quota or private mode — fine, next time downloads again */
    }
  }
  return bytes.buffer
}

function loadSession(factor: UpscaleFactor, onProgress?: (p: UpscaleProgress) => void, signal?: AbortSignal): Promise<Session> {
  let promise = sessionPromises[factor]
  if (!promise) {
    promise = (async () => {
      const [ort, weights] = await Promise.all([loadOrt(), fetchWeights(MODEL_URL[factor], factor, onProgress, signal)])
      return ort.InferenceSession.create(weights, { executionProviders: ['wasm'] })
    })()
    promise.catch(() => {
      if (sessionPromises[factor] === promise) delete sessionPromises[factor]
    })
    sessionPromises[factor] = promise
  }
  return promise
}

/** Symmetric (reflect) index — -1 → 0, n → n-1. */
function refl(i: number, n: number): number {
  let j = i
  while (j < 0 || j >= n) j = j < 0 ? -j - 1 : 2 * n - j - 1
  return j
}

/**
 * Upscale `img` by `factor` with the model. RGB goes through the model composited over
 * white; alpha (if the image has any) is upscaled bilinearly and the colour un-composited
 * under it — the measured lanes were opaque, and this keeps a transparent upload's
 * transparency without a second model pass.
 */
export async function aiUpscale(
  img: ImageData,
  factor: UpscaleFactor,
  onProgress?: (p: UpscaleProgress) => void,
  signal?: AbortSignal,
): Promise<ImageData> {
  const session = await loadSession(factor, onProgress, signal)
  const ort = await loadOrt()
  onProgress?.({ phase: 'process', factor })

  const { width: W, height: H, data } = img
  let hasAlpha = false
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] !== 255) {
      hasAlpha = true
      break
    }
  }

  // Pad the border the model eats, then up to the multiple it demands (right/bottom).
  let PW = W + 2 * BORDER
  let PH = H + 2 * BORDER
  const extraW = (MULTIPLE - (PW % MULTIPLE)) % MULTIPLE
  const extraH = (MULTIPLE - (PH % MULTIPLE)) % MULTIPLE
  PW += extraW
  PH += extraH
  const x = new Float32Array(3 * PW * PH)
  for (let y = 0; y < PH; y++) {
    const sy = refl(y - BORDER, H)
    for (let px = 0; px < PW; px++) {
      const sx = refl(px - BORDER, W)
      const i = (sy * W + sx) * 4
      const a = data[i + 3] / 255
      for (let c = 0; c < 3; c++) x[c * PW * PH + y * PW + px] = (data[i + c] * a + 255 * (1 - a)) / 255
    }
  }

  const feeds = { [session.inputNames[0]]: new ort.Tensor('float32', x, [1, 3, PH, PW]) }
  const out = await session.run(feeds)
  const y = out[session.outputNames[0]]
  const OW = y.dims[3] as number
  const OH = y.dims[2] as number
  const k = factor
  if (OW !== (PW - 2 * BORDER) * k || OH !== (PH - 2 * BORDER) * k) {
    throw new Error(`upscaler: unexpected output ${OW}×${OH} for input ${PW}×${PH}`)
  }
  const planes = y.data as Float32Array

  const RW = W * k
  const RH = H * k
  const result = new ImageData(RW, RH)
  const rd = result.data
  const alphaUp = hasAlpha ? upscaleImageData({ width: W, height: H, data }, k).data : null
  for (let yy = 0; yy < RH; yy++) {
    for (let xx = 0; xx < RW; xx++) {
      const si = yy * OW + xx
      const o = (yy * RW + xx) * 4
      const a = alphaUp ? alphaUp[o + 3] : 255
      for (let c = 0; c < 3; c++) {
        let v = Math.min(1, Math.max(0, planes[c * OW * OH + si])) * 255
        // Un-composite from white under the bilinear alpha so a transparent upload keeps
        // its edge colours instead of a white fringe.
        if (a > 0 && a < 255) v = Math.min(255, Math.max(0, (v - 255 * (1 - a / 255)) / (a / 255)))
        rd[o + c] = Math.round(v)
      }
      rd[o + 3] = a
    }
  }
  return result
}
