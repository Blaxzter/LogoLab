// Node-only glue for the headless harness: installs a minimal ImageData global
// (the tracing pipeline constructs `new ImageData(w, h)` for its masks) and
// loads corpus PNGs into ImageData via the local decoder. Never imported by the
// browser harness — that side uses canvas/getImageData.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { decodePng, type DecodedImage } from './png.ts'

/** Install a minimal ImageData polyfill if the runtime lacks one (Node). */
export function ensureImageData(): void {
  const g = globalThis as unknown as { ImageData?: unknown }
  if (typeof g.ImageData !== 'undefined') return
  class NodeImageData {
    width: number
    height: number
    data: Uint8ClampedArray
    constructor(a: number | Uint8ClampedArray, b?: number, c?: number) {
      if (typeof a === 'number') {
        this.width = a
        this.height = b as number
        this.data = new Uint8ClampedArray(a * (b as number) * 4)
      } else {
        this.data = a
        this.width = b as number
        this.height = (c ?? a.length / 4 / (b as number)) as number
      }
    }
  }
  g.ImageData = NodeImageData as unknown
}

/** Project root, derived from this module's location (src/devtest). */
function projectRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..')
}

/** Decode a PNG (path relative to the project root) into a DecodedImage. */
export function loadPng(relPath: string): DecodedImage {
  const bytes = readFileSync(join(projectRoot(), relPath))
  return decodePng(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength))
}

/** The PNG corpus the headless harness scores (the hand-made SVG set is rendered
 *  in the browser harness, which can rasterize arbitrary SVG). */
export const PNG_CORPUS: { name: string; path: string }[] = [
  { name: 'nebula', path: 'public/examples/nebula.png' },
  { name: 'petals', path: 'public/examples/petals.png' },
]
