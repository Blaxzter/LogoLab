// Reading a caption's text out of its pixels — Tesseract.js, loaded on demand.
//
// Browser-only (Worker, canvas, network), and deliberately NOT re-exported from
// the sheet barrel, same as traceTile.ts: the Node tests import the pairing and
// the preprocessing from captions.ts without dragging an OCR engine in.
//
// Tesseract.js is a dynamic import, so its client never touches the initial
// bundle; the engine itself — worker script, WASM core (~4 MB) and the English
// model (~2 MB) — comes from the library's CDN defaults on first use, and the
// model is cached in IndexedDB by the library. Nothing of the sheet leaves the
// tab: the pixels go to a Worker on this page, not to a server.

import { imageDataToCanvas } from '../image'
import { toImageData } from './crop.ts'
import type { ImageDataLike } from './types'

/**
 * The "fast" integer models — a fifth of the standard download. Measured on the
 * 28 captions of the two captioned example sheets at 2048, 1024 and 768px: every
 * one read correctly at ≥ 90% confidence (with the denoise in `prepareCaption`).
 * The standard set was no better on them, and the "best" set needs the non-SIMD
 * core (it aborts on a missing DotProduct symbol in the SIMD build).
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
const LOAD_STAGES = ['loading tesseract core', 'initializing tesseract', 'loading language traineddata', 'initialized api']

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
  // A caption IS one line of text. Page-layout analysis on a 200px crop only
  // invents columns and paragraphs around it.
  await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE })

  let queue: Promise<unknown> = Promise.resolve()
  return {
    read(pixels) {
      const job = queue.then(async () => {
        // The worker takes encoded bytes, not raw pixels — PNG is lossless and
        // a caption crop is tiny, so the round trip costs nothing visible.
        // Encoded SYNCHRONOUSLY on purpose: `canvas.toBlob` hands its result to
        // a task Chrome throttles to once a second in a background tab, and a
        // 16-caption run measured 1000ms per caption that way against 1–2ms
        // here — the user is likely to switch tabs while an engine downloads.
        const url = imageDataToCanvas(toImageData(pixels)).toDataURL('image/png')
        const { data } = await worker.recognize(url)
        return { text: data.text.replace(/\s+/g, ' ').trim(), confidence: data.confidence }
      })
      queue = job.catch(() => undefined)
      return job
    },
  }
}
