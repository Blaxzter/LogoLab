// In-browser AI background removal via Transformers.js + briaai/RMBG-1.4.
//
// The model (~tens of MB) is downloaded from the Hugging Face Hub on first use
// and cached by the browser, then runs entirely client-side (WASM) — no upload,
// consistent with LogoLab's "100% in your browser" promise. The whole
// @huggingface/transformers bundle is loaded via dynamic import() so it never
// touches the initial app bundle: nothing here is paid for until the user
// clicks "AI auto-remove".
//
// This file is the one deliberately loosely-typed boundary in the codebase:
// the library's Tensor proxy (numeric indexing, .mul/.to) isn't expressible in
// strict TS, so the model I/O is treated as `any` and isolated here.

export interface AiProgress {
  /** 'download' while fetching model files, 'process' during inference. */
  phase: 'download' | 'process'
  /** 0–100 download percentage (download phase only). */
  percent?: number
  /** Current file being fetched (download phase only). */
  file?: string
  /** Backend that actually ran the model — set once a device is confirmed. */
  device?: Device
}

type Device = 'webgpu' | 'wasm'

const MODEL_ID = 'briaai/RMBG-1.4'

// RMBG-1.4 ships a non-standard config; these are the processor settings from
// the official Transformers.js background-removal example.
const PROCESSOR_CONFIG = {
  do_normalize: true,
  do_pad: false,
  do_rescale: true,
  do_resize: true,
  image_mean: [0.5, 0.5, 0.5],
  image_std: [1, 1, 1],
  resample: 2,
  rescale_factor: 1 / 255,
  size: { width: 1024, height: 1024 },
} as const

/**
 * Pick the best available backend. Returns 'webgpu' only if the browser can
 * actually hand us a usable GPU *device* — not merely an adapter. On Apple
 * Silicon `requestAdapter()` frequently resolves while `requestDevice()` then
 * fails or the device is unusable, which is the exact case that made
 * auto-selection blow up with no fallback.
 *
 * This up-front probe is the PRIMARY defense, not the cross-device retry in
 * `aiRemoveBackground`: Transformers.js serializes every web session through a
 * shared promise chain that stays rejected once a webgpu session fails, so a
 * wasm retry queued behind a poisoned chain may never run. Proving a real
 * device here means we never start a doomed webgpu session in the first place.
 */
export async function pickDevice(): Promise<Device> {
  try {
    // `navigator.gpu` is part of the WebGPU API; we don't pull in @webgpu/types
    // (it's the only spot we touch it), so reach it through the loose boundary.
    type Adapter = { requestDevice(): Promise<{ destroy?(): void } | null> }
    const gpu = (navigator as { gpu?: { requestAdapter(): Promise<Adapter | null> } }).gpu
    const adapter = await gpu?.requestAdapter()
    if (!adapter) return 'wasm'
    // Creating (and immediately discarding) a device proves webgpu is actually
    // functional, catching the "adapter exists but device fails" Apple-Silicon case.
    const device = await adapter.requestDevice()
    device?.destroy?.()
    return device ? 'webgpu' : 'wasm'
  } catch {
    return 'wasm'
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LoadedModel = { model: any; processor: any }

// Cache the load promise per device so a failed webgpu attempt doesn't poison a
// subsequent wasm one (and vice versa).
const modelPromises: Partial<Record<Device, Promise<LoadedModel>>> = {}

/** Load (and cache for the session) the RMBG model + processor on `device`. */
function loadModel(device: Device, onProgress?: (p: AiProgress) => void) {
  let promise = modelPromises[device]
  if (!promise) {
    promise = (async () => {
      const { AutoModel, AutoProcessor, env } = await import('@huggingface/transformers')
      // Browser-only: never look for models on a local filesystem path.
      env.allowLocalModels = false
      // Transformers.js fires `progress` per file, and the model + processor
      // download in parallel (shared callback). Reporting one file's percent
      // makes the bar jump backwards as each new file starts, so we aggregate by
      // bytes across every file we've seen into a single overall percentage.
      const seen = new Map<string, { loaded: number; total: number }>()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const progress_callback = (p: any) => {
        if (p?.status !== 'progress') return
        if (typeof p.loaded === 'number' && typeof p.total === 'number' && p.total > 0) {
          seen.set(p.file ?? p.name ?? String(seen.size), { loaded: p.loaded, total: p.total })
          let loaded = 0
          let total = 0
          for (const v of seen.values()) {
            loaded += v.loaded
            total += v.total
          }
          onProgress?.({
            phase: 'download',
            percent: total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : undefined,
            file: p.file,
          })
        } else if (typeof p.progress === 'number') {
          onProgress?.({ phase: 'download', percent: Math.round(p.progress), file: p.file })
        }
      }
      const [model, processor] = await Promise.all([
        AutoModel.from_pretrained(MODEL_ID, {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          config: { model_type: 'custom' } as any,
          // Pin the backend + precision explicitly: letting Transformers.js
          // auto-select silently chose a broken WebGPU path on Apple Silicon.
          device,
          dtype: 'fp32',
          progress_callback,
        }),
        AutoProcessor.from_pretrained(MODEL_ID, {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          config: PROCESSOR_CONFIG as any,
          progress_callback,
        }),
      ])
      return { model, processor }
    })()
    // A failed load shouldn't poison this device's cache — let it retry (and
    // crucially, don't poison the *other* device's entry).
    promise.catch(() => {
      if (modelPromises[device] === promise) delete modelPromises[device]
    })
    modelPromises[device] = promise
  }
  return promise
}

/**
 * Run the loaded RMBG model on `img` and return a copy with the predicted
 * background made transparent (the model's foreground-probability mask
 * multiplies the alpha). The input should be the opaque original for best
 * results.
 */
async function runInference(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  model: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  processor: any,
  img: ImageData,
  onProgress?: (p: AiProgress) => void,
): Promise<ImageData> {
  const { RawImage } = await import('@huggingface/transformers')
  onProgress?.({ phase: 'process' })

  // Hand the pixels to the library as a PNG data URL — the most robust input
  // (RawImage normalizes channels/orientation for us).
  const canvas = document.createElement('canvas')
  canvas.width = img.width
  canvas.height = img.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D context unavailable')
  ctx.putImageData(img, 0, 0)
  const image = await RawImage.fromURL(canvas.toDataURL('image/png'))

  const { pixel_values } = await processor(image)
  const { output } = await model({ input: pixel_values })

  // output[0] is a [1, H, W] foreground-probability map; scale to 0–255 and
  // resize back to the original resolution → a single-channel alpha mask.
  const mask = await RawImage.fromTensor(output[0].mul(255).to('uint8')).resize(
    img.width,
    img.height,
  )

  const out = new ImageData(new Uint8ClampedArray(img.data), img.width, img.height)
  const m = mask.data as Uint8Array | Uint8ClampedArray
  const n = img.width * img.height
  for (let i = 0; i < n; i++) {
    // Combine with any existing alpha so this also behaves on pre-edited input.
    out.data[i * 4 + 3] = Math.round((out.data[i * 4 + 3] * m[i]) / 255)
  }
  return out
}

/**
 * Run RMBG-1.4 on `img` and return a copy with the predicted background made
 * transparent.
 *
 * Tries the probed device first, then falls back to wasm. The fallback wraps
 * inference, not just the load: WebGPU on Apple Silicon can load fine and then
 * produce NaNs / throw during the forward pass, so a device is only trusted
 * once it has produced a result — at which point `onProgress` reports the
 * confirmed device so the UI can show e.g. "AI ready (wasm)".
 */
export async function aiRemoveBackground(
  img: ImageData,
  onProgress?: (p: AiProgress) => void,
): Promise<ImageData> {
  const picked = await pickDevice()
  // Always end on wasm (the correctness fallback); skip the duplicate when the
  // probe already chose wasm.
  const devices: Device[] = picked === 'wasm' ? ['wasm'] : [picked, 'wasm']

  let lastErr: unknown
  for (const device of devices) {
    try {
      const { model, processor } = await loadModel(device, onProgress)
      const out = await runInference(model, processor, img, onProgress)
      // Only now is the device proven (webgpu can load then NaN mid-forward);
      // report it last so the UI's device label reflects what actually ran.
      onProgress?.({ phase: 'process', device })
      return out
    } catch (err) {
      lastErr = err
      // wasm is the last resort: if it failed there's nowhere left to fall back
      // to, so surface the real error.
      if (device === 'wasm') throw err
      // A webgpu load or forward pass failed — warn, drop its cache entry so a
      // retry doesn't reuse the broken model, and try the next device.
      console.warn(`[aiRemove] ${device} failed, falling back to wasm`, err)
      delete modelPromises[device]
    }
  }
  // Unreachable (the loop always ends on wasm, which rethrows), but keeps TS
  // happy about the return type.
  throw lastErr
}
