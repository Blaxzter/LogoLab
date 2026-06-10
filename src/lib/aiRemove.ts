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
}

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let modelPromise: Promise<{ model: any; processor: any }> | null = null

/** Load (and cache for the session) the RMBG model + processor. */
function loadModel(onProgress?: (p: AiProgress) => void) {
  if (!modelPromise) {
    modelPromise = (async () => {
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
    // A failed load shouldn't poison the cache — let the next click retry.
    modelPromise.catch(() => {
      modelPromise = null
    })
  }
  return modelPromise
}

/**
 * Run RMBG-1.4 on `img` and return a copy with the predicted background made
 * transparent (the model's foreground-probability mask multiplies the alpha).
 * The input should be the opaque original for best results.
 */
export async function aiRemoveBackground(
  img: ImageData,
  onProgress?: (p: AiProgress) => void,
): Promise<ImageData> {
  const { RawImage } = await import('@huggingface/transformers')
  const { model, processor } = await loadModel(onProgress)
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
