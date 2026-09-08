// Apple icon container (.icns) — the macOS half of "and whatever collection is
// needed" (Tauri and Electron both want one next to the .ico).
//
// The format is a flat container: the magic 'icns', the total length, then one
// entry per image — a four-character OSType, the entry length INCLUDING its own
// 8-byte header, and the payload. Every type emitted here takes a PNG payload,
// which is what `iconutil` itself writes for a modern .iconset, so no ARGB or
// RLE encoder is needed.

/**
 * The canonical iconset: each entry is an OSType and the pixel size of the PNG it
 * holds. `iconutil -c icns` on a full .iconset emits exactly this set — the @2x
 * variants are separate types at double the point size.
 */
export const ICNS_TYPES: { type: string; size: number; label: string }[] = [
  { type: 'icp4', size: 16, label: '16x16' },
  { type: 'ic11', size: 32, label: '16x16@2x' },
  { type: 'icp5', size: 32, label: '32x32' },
  { type: 'ic12', size: 64, label: '32x32@2x' },
  { type: 'ic07', size: 128, label: '128x128' },
  { type: 'ic13', size: 256, label: '128x128@2x' },
  { type: 'ic08', size: 256, label: '256x256' },
  { type: 'ic14', size: 512, label: '256x256@2x' },
  { type: 'ic09', size: 512, label: '512x512' },
  { type: 'ic10', size: 1024, label: '512x512@2x' },
]

/** The distinct pixel sizes an .icns needs rendered. */
export const ICNS_SIZES: number[] = [...new Set(ICNS_TYPES.map((t) => t.size))].sort((a, b) => a - b)

/**
 * Assemble an .icns from PNGs keyed by pixel size. Sizes that are missing are
 * skipped rather than faked, so a caller can emit a smaller container on purpose.
 */
export function encodeIcns(pngBySize: Map<number, Uint8Array>): Uint8Array {
  const entries = ICNS_TYPES.map((t) => ({ ...t, png: pngBySize.get(t.size) })).filter(
    (e): e is { type: string; size: number; label: string; png: Uint8Array } => e.png != null,
  )
  if (!entries.length) throw new Error('encodeIcns: no PNGs to pack')

  const total = 8 + entries.reduce((n, e) => n + 8 + e.png.byteLength, 0)
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)

  // Header: 'icns' + total file length (big-endian, the whole file).
  out.set([0x69, 0x63, 0x6e, 0x73], 0)
  view.setUint32(4, total, false)

  let at = 8
  for (const e of entries) {
    for (let i = 0; i < 4; i++) out[at + i] = e.type.charCodeAt(i)
    view.setUint32(at + 4, 8 + e.png.byteLength, false)
    out.set(e.png, at + 8)
    at += 8 + e.png.byteLength
  }
  return out
}
