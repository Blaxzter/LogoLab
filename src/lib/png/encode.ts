// Minimal PNG ENCODER for the headless harness (Node only) — the counterpart to
// png.ts's decoder. Writes a non-interlaced 8-bit RGBA (color type 6) PNG using
// the built-in node:zlib, with one "none" filter byte per scanline. No new deps,
// dev/test only (never reaches the app bundle). Good enough for inspection PNGs;
// not optimised for size.

import { deflateSync } from 'node:zlib'

const SIG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])

/** CRC32 (PNG/zlib polynomial) over a byte range. */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function u32(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff])
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}

/** Build a single PNG chunk: len, type, data, CRC(type+data). */
function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new Uint8Array([type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3)])
  const body = concat([typeBytes, data])
  return concat([u32(data.length), body, u32(crc32(body))])
}

/**
 * Encode row-major RGBA8 pixels into a PNG byte buffer.
 */
export function encodePng(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): Uint8Array {
  // IHDR: width, height, bitDepth=8, colorType=6 (RGBA), compression=0, filter=0, interlace=0
  const ihdr = concat([u32(width), u32(height), new Uint8Array([8, 6, 0, 0, 0])])

  // Raw scanlines, each prefixed with filter type 0 (none).
  const stride = width * 4
  const raw = new Uint8Array((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    raw.set(rgba.subarray(y * stride, y * stride + stride), y * (stride + 1) + 1)
  }
  const idat = deflateSync(raw, { level: 6 })

  return concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', new Uint8Array(idat)), chunk('IEND', new Uint8Array(0))])
}
