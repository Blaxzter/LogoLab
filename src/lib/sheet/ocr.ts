// Reading a caption's text out of its pixels with Tesseract.js, loaded on demand.
//
// Browser-only and not re-exported from the sheet barrel, so Node tests can
// import captions.ts without an OCR engine. Tesseract.js is a dynamic import;
// the engine and English model come from the CDN on first use (cached in
// IndexedDB by the library). Recognition runs in a local Worker; no pixels
// leave the tab.

import { imageDataToCanvas } from '../image'
import { toImageData } from './crop.ts'
import type { ImageDataLike } from './types'

/**
 * The "fast" integer models: a fifth of the standard download and accurate
 * enough for captions. Don't switch to the "best" set: it aborts on the SIMD
 * core (missing DotProduct symbol).
 */
const TESSDATA_URL = 'https://tessdata.projectnaptha.com/4.0.0_fast'

export interface CaptionRead {
  /** The line as read, whitespace collapsed. Empty when nothing was recognised. */
  text: string
  /** Tesseract's 0–100 confidence in the line. */
  confidence: number
}

export interface CaptionReader {
  /** Read one prepared caption crop (see `prepareCaption`). Reads are serialised. */
  read(pixels: ImageDataLike): Promise<CaptionRead>
}

/** What the engine load reports, in order — mapped onto one 0–1 fraction. */
const LOAD_STAGES = [
  'loading tesseract core',
  'initializing tesseract',
  'loading language traineddata',
  'initialized api',
]

export function captionOcrSupported(): boolean {
  return typeof Worker !== 'undefined' && typeof WebAssembly !== 'undefined'
}

let readerPromise: Promise<CaptionReader> | null = null
const loadListeners = new Set<(fraction: number) => void>()

/**
 * The one OCR engine for the session, created on first call. A failed load is
 * forgotten so the next call can try again (a flaky CDN fetch should not
 * disable the feature until reload).
 */
export function loadCaptionReader(onProgress?: (fraction: number) => void): Promise<CaptionReader> {
  if (onProgress) loadListeners.add(onProgress)
  if (!readerPromise) {
    readerPromise = createReader().catch((err) => {
      readerPromise = null
      throw err
    })
  }
  return readerPromise.finally(() => {
    if (onProgress) loadListeners.delete(onProgress)
  })
}

async function createReader(): Promise<CaptionReader> {
  const { createWorker, OEM, PSM } = await import('tesseract.js')
  const worker = await createWorker('eng', OEM.LSTM_ONLY, {
    langPath: TESSDATA_URL,
    logger: (m: { status: string; progress: number }) => {
      const stage = LOAD_STAGES.indexOf(m.status)
      if (stage < 0) return
      const fraction = Math.min(1, (stage + Math.max(0, Math.min(1, m.progress))) / LOAD_STAGES.length)
      for (const fn of loadListeners) fn(fraction)
    },
  })
  // A caption is one line; page-layout analysis would only invent structure.
  await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE })

  let queue: Promise<unknown> = Promise.resolve()
  return {
    read(pixels) {
      const job = queue.then(async () => {
        // The worker takes encoded bytes. Encode synchronously: don't use
        // `canvas.toBlob`, whose callback Chrome throttles to once a second in a
        // background tab, stalling every caption.
        const url = imageDataToCanvas(toImageData(pixels)).toDataURL('image/png')
        const { data } = await worker.recognize(url)
        return { text: data.text.replace(/\s+/g, ' ').trim(), confidence: data.confidence }
      })
      queue = job.catch(() => undefined)
      return job
    },
  }
}
