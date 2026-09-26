// Minimal PNG decoder for the headless harness (Node only).
//
// The browser harness gets pixels from canvas/getImageData; under `node --test`
// there is no canvas, so we decode the corpus PNGs ourselves. zlib is the only
// non-trivial dependency and it is built into Node (`node:zlib`) — no new
// package, in keeping with the "no new runtime deps" rule (this file is dev/test
// only and never reaches the app bundle).
//
// Supports the common non-interlaced cases: bit depth 8/16, colour types 0
// (gray), 2 (RGB), 3 (palette), 4 (gray+alpha), 6 (RGBA), and sub-byte palette/
// gray depths (1/2/4). Interlaced (Adam7) PNGs throw — the corpus is not
// interlaced.

import { inflateSync } from 'node:zlib'

export interface DecodedImage {
  width: number
  height: number
  /** Row-major RGBA, 8 bits per channel. */
  data: Uint8ClampedArray
}

const SIG = [137, 80, 78, 71, 13, 10, 26, 10]

export function decodePng(bytes: Uint8Array): DecodedImage {
  for (let i = 0; i < SIG.length; i++) {
    if (bytes[i] !== SIG[i]) throw new Error('not a PNG (bad signature)')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  let width = 0
  let height = 0
  let bitDepth = 8
  let colorType = 6
  let interlace = 0
  let palette: Uint8Array | null = null
  let trns: Uint8Array | null = null
  const idat: Uint8Array[] = []

  let off = 8
  while (off < bytes.length) {
    const len = view.getUint32(off)
    const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7])
    const dataStart = off + 8
    if (type === 'IHDR') {
      width = view.getUint32(dataStart)
      height = view.getUint32(dataStart + 4)
      bitDepth = bytes[dataStart + 8]
      colorType = bytes[dataStart + 9]
      interlace = bytes[dataStart + 12]
    } else if (type === 'PLTE') {
      palette = bytes.subarray(dataStart, dataStart + len)
    } else if (type === 'tRNS') {
      trns = bytes.subarray(dataStart, dataStart + len)
    } else if (type === 'IDAT') {
      idat.push(bytes.subarray(dataStart, dataStart + len))
    } else if (type === 'IEND') {
      break
    }
    off = dataStart + len + 4 // skip CRC
  }

  if (interlace !== 0) throw new Error('interlaced PNG (Adam7) not supported')
  if (width === 0 || height === 0) throw new Error('PNG has zero dimensions')

  const channels = channelCount(colorType)
  const raw = inflateSync(concat(idat))
  const unfiltered = unfilter(raw, width, height, bitDepth, channels)
  return { width, height, data: toRgba(unfiltered, width, height, bitDepth, colorType, channels, palette, trns) }
}

function channelCount(colorType: number): number {
  switch (colorType) {
    case 0: return 1 // grayscale
    case 2: return 3 // RGB
    case 3: return 1 // palette index
    case 4: return 2 // gray + alpha
    case 6: return 4 // RGBA
    default: throw new Error('unsupported PNG color type ' + colorType)
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

/** Reverse PNG scanline filters in place, returning packed sample bytes. */
function unfilter(raw: Uint8Array, width: number, height: number, bitDepth: number, channels: number): Uint8Array {
  const bitsPerPixel = channels * bitDepth
  const bpp = Math.max(1, Math.ceil(bitsPerPixel / 8))
  const rowBytes = Math.ceil((bitsPerPixel * width) / 8)
  const out = new Uint8Array(rowBytes * height)

  let pos = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++]
    const rowStart = y * rowBytes
    const prevStart = (y - 1) * rowBytes
    for (let i = 0; i < rowBytes; i++) {
      const x = raw[pos++]
      const a = i >= bpp ? out[rowStart + i - bpp] : 0
      const b = y > 0 ? out[prevStart + i] : 0
      const c = y > 0 && i >= bpp ? out[prevStart + i - bpp] : 0
      let val: number
      switch (filter) {
        case 0: val = x; break
        case 1: val = x + a; break
        case 2: val = x + b; break
        case 3: val = x + ((a + b) >> 1); break
        case 4: val = x + paeth(a, b, c); break
        default: throw new Error('unknown PNG filter ' + filter)
      }
      out[rowStart + i] = val & 0xff
    }
  }
  return out
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

/** Expand packed samples to RGBA8, applying palette / tRNS / depth scaling. */
function toRgba(
  s: Uint8Array,
  width: number,
  height: number,
  bitDepth: number,
  colorType: number,
  channels: number,
  palette: Uint8Array | null,
  trns: Uint8Array | null,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4)
  const rowBytes = Math.ceil((channels * bitDepth * width) / 8)
  const maxVal = (1 << bitDepth) - 1

  // Read sample `c` of pixel `x` in row `y`, normalized to 0–255.
  const sample = (y: number, x: number, c: number): number => {
    if (bitDepth === 8) return s[y * rowBytes + (x * channels + c)]
    if (bitDepth === 16) return s[y * rowBytes + (x * channels + c) * 2] // high byte
    // Sub-byte (1/2/4): unpack MSB-first.
    const bitIndex = (x * channels + c) * bitDepth
    const byte = s[y * rowBytes + (bitIndex >> 3)]
    const shift = 8 - bitDepth - (bitIndex & 7)
    return (byte >> shift) & maxVal
  }
  // For grayscale, scale the small range up to 0–255.
  const grayScale = bitDepth < 8 ? 255 / maxVal : 1

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4
      if (colorType === 3) {
        const idx = sample(y, x, 0)
        const p = idx * 3
        out[o] = palette ? palette[p] : 0
        out[o + 1] = palette ? palette[p + 1] : 0
        out[o + 2] = palette ? palette[p + 2] : 0
        out[o + 3] = trns && idx < trns.length ? trns[idx] : 255
      } else if (colorType === 0) {
        const g = sample(y, x, 0) * grayScale
        out[o] = g
        out[o + 1] = g
        out[o + 2] = g
        out[o + 3] = 255
      } else if (colorType === 4) {
        const g = sample(y, x, 0) * grayScale
        out[o] = g
        out[o + 1] = g
        out[o + 2] = g
        out[o + 3] = sample(y, x, 1) * grayScale
      } else if (colorType === 2) {
        out[o] = sample(y, x, 0)
        out[o + 1] = sample(y, x, 1)
        out[o + 2] = sample(y, x, 2)
        out[o + 3] = 255
      } else {
        out[o] = sample(y, x, 0)
        out[o + 1] = sample(y, x, 1)
        out[o + 2] = sample(y, x, 2)
        out[o + 3] = sample(y, x, 3)
      }
    }
  }
  return out
}
