// In-browser AI super-resolution in front of the colour tracer: waifu2x swin_unet
// via onnxruntime-web, lazy-loaded. Only used on small rasters (see
// `aiUpscaleFactor`). This model is chosen because it emits nearly hard edges
// between the exact source colours, which suits palette segmentation; models that
// repaint flat colours or add edge rims make the trace worse.
//
// Nothing is bundled. The runtime (script + WASM) is imported from the CDN on
// first use; don't make `onnxruntime-web` a bundled dependency, or Vite emits its
// WASM binaries into dist/assets and they exceed the deploy's per-file size limit.
// The weights come from the Hugging Face Hub and are kept in the Cache API; the
// `no-referrer` meta in index.html is what gets past the Hub's hotlink
// protection. WASM backend only.
//
// The ORT session API is typed `any` and kept inside this file.

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
 * Rasters longer than this are traced as-is: the tracer's own error is already
 * negligible there, and inference time scales with the output area.
 */
export const AI_UPSCALE_MAX_PX = 320
/**
 * Below this, ×4; from here to the max, ×2, so the result lands near ~512 px as
 * `traceScale` does for mono.
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
/** … and only accepts sizes that are a multiple of this. */
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
      // Threads need cross-origin isolation (COOP/COEP); ask for one thread
      // otherwise rather than letting ORT fall back with a warning.
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
 * Upscale `img` by `factor` with the model. RGB goes through the model composited
 * over white; alpha, if any, is upscaled bilinearly and the colour un-composited
 * under it, which keeps transparency without a second model pass.
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
