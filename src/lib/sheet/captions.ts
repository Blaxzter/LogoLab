// Captions → icon names: which caption belongs to which icon, and how a line of
// OCR'd text becomes a file name.
//
// The detector already tells captions apart from icons (short text bands, see
// detect.ts); what it does not say is WHOSE caption each one is. A sheet from an
// image model puts the caption directly under its icon, closer than anything
// else on the page, so the pairing is geometric: the nearest text below an icon,
// inside that icon's column, is its caption. Everything here is pure and works
// on the detector's tiles, so the browser and the Node harness pair identically;
// reading the text out of the pixels (OCR) lives in ocr.ts, which is browser-only.

import { cropTile, upscaleImageData } from './crop.ts'
import type { ImageDataLike, Rect, SheetBackground, SheetGrid, SheetTile } from './types'

/**
 * How far below an icon its caption may start, as a fraction of the grid pitch
 * (or of the icon's own height on a free layout). Real sheets put the caption
 * 15–25% of the pitch under the icon; the NEXT row's caption is a full pitch
 * away, so 0.5 sits in open space between the two.
 */
const MAX_GAP_PITCH = 0.5
/**
 * A caption is no wider than its column. A text run wider than this many pitches
 * is a section title spanning the row, which belongs to no single icon.
 */
const MAX_WIDTH_PITCH = 1.25
/**
 * A caption is one or two short lines. A second line sits within this many
 * line-heights under the first; anything further is the next row's business.
 */
const SECOND_LINE_GAP = 1.0

export interface CaptionMatch {
  /** The caption's text tiles, top line first. */
  labels: SheetTile[]
  /** Union of the caption's ink, in source px. */
  ink: Rect
}

/**
 * Pair every icon tile with the caption under it.
 *
 * Greedy by vertical gap: the closest (icon, caption) pair wins, so a caption
 * that lies between two rows goes to the icon it sits under, never to the one it
 * sits above. A caption broken into two lines (the detector groups per band, so
 * "SECURITY" / "CAMERA" arrive as two tiles) is stitched back together by
 * absorbing text directly under the matched line.
 */
export function matchCaptions(tiles: SheetTile[], grid: SheetGrid | null): Map<string, CaptionMatch> {
  const icons = tiles.filter((t) => t.kind === 'icon')
  const labels = tiles.filter((t) => t.kind === 'label')
  const out = new Map<string, CaptionMatch>()
  if (icons.length === 0 || labels.length === 0) return out

  const heights = icons.map((t) => t.ink.h).sort((a, b) => a - b)
  const medianH = heights[heights.length >> 1]
  const widths = icons.map((t) => t.ink.w).sort((a, b) => a - b)
  const medianW = widths[widths.length >> 1]
  // Pitch: the grid's when there is one, else what the icons themselves suggest.
  const pitchY = grid?.pitchY || medianH * 1.6
  const pitchX = grid?.pitchX || medianW * 1.6
  const maxGap = MAX_GAP_PITCH * pitchY
  const maxWidth = MAX_WIDTH_PITCH * pitchX

  const candidates: { icon: SheetTile; label: SheetTile; gap: number }[] = []
  for (const icon of icons) {
    const bottom = icon.ink.y + icon.ink.h
    for (const label of labels) {
      if (label.ink.w > maxWidth) continue
      const gap = label.ink.y - bottom
      // A caption starts under the icon's ink (a little overlap is the label
      // band's own anti-aliasing, not the caption sitting on the icon).
      if (gap < -0.1 * icon.ink.h || gap > maxGap) continue
      if (!sameColumn(icon.ink, label.ink)) continue
      candidates.push({ icon, label, gap })
    }
  }
  candidates.sort((a, b) => a.gap - b.gap)

  const taken = new Set<string>()
  for (const c of candidates) {
    if (out.has(c.icon.id) || taken.has(c.label.id)) continue
    out.set(c.icon.id, { labels: [c.label], ink: { ...c.label.ink } })
    taken.add(c.label.id)
  }

  // Second lines: text directly under a matched caption line, still inside the
  // column and not claimed by anything else.
  const free = labels.filter((l) => !taken.has(l.id)).sort((a, b) => a.ink.y - b.ink.y)
  for (const match of out.values()) {
    let last = match.labels[match.labels.length - 1]
    for (const label of free) {
      if (taken.has(label.id)) continue
      const gap = label.ink.y - (last.ink.y + last.ink.h)
      if (gap < 0 || gap > SECOND_LINE_GAP * last.ink.h) continue
      if (!sameColumn(match.ink, label.ink)) continue
      match.labels.push(label)
      match.ink = union(match.ink, label.ink)
      taken.add(label.id)
      last = label
    }
  }
  return out
}

/** The caption's centre lies over the icon, or the icon's over the caption. */
function sameColumn(a: Rect, b: Rect): boolean {
  const ac = a.x + a.w / 2
  const bc = b.x + b.w / 2
  return (bc >= a.x && bc <= a.x + a.w) || (ac >= b.x && ac <= b.x + b.w)
}

function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y }
}

// ---------------------------------------------------------------------------
// Text → name
// ---------------------------------------------------------------------------

/** Longest file-name stem a caption may become. */
const MAX_SLUG = 48

/**
 * A caption as a file-name stem: `"SECURITY CAMERA"` → `security-camera`,
 * `"Café & Bar"` → `cafe-and-bar`. Null when nothing usable is left — OCR on a
 * caption it could not read returns punctuation, not an empty string.
 */
export function captionToName(text: string): string | null {
  const words = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  let slug = ''
  for (const word of words) {
    const next = slug ? `${slug}-${word}` : word
    if (next.length > MAX_SLUG) break
    slug = next
  }
  return slug || null
}

/** Illegal in a file name on any platform the export could land on. */
const UNSAFE_NAME = /[<>:"/\\|?*\u0000-\u001f]/g

/**
 * Prefix and suffix are typed by hand; keep them from breaking the file names.
 * Spaces become dashes rather than vanishing — `"my icons "` means `my-icons-`.
 */
export function cleanAffix(text: string): string {
  return text.replace(UNSAFE_NAME, '').replace(/\s+/g, '-')
}

/** The name a tile is exported under: the sheet's prefix and suffix around its own name. */
export function exportName(name: string, prefix: string, suffix: string): string {
  return `${cleanAffix(prefix)}${name}${cleanAffix(suffix)}`
}

// ---------------------------------------------------------------------------
// The pixels the OCR reads
// ---------------------------------------------------------------------------

/** Margin around the caption ink, as a fraction of its height — Tesseract wants air around a line. */
const CAPTION_PAD = 0.6
/** Text height (px) the OCR is shown; a smaller caption is enlarged up to this. */
const CAPTION_TARGET_H = 48
const MAX_CAPTION_SCALE = 4

/**
 * Cut a caption out of the sheet as dark grey text on light paper, at a size
 * the OCR reads well.
 *
 * Tesseract is trained on dark-on-light print, so light captions on a dark
 * sheet are inverted, and a transparent sheet's alpha IS the ink (a white
 * caption over transparency has no colour contrast at all). Enlarging small
 * captions (a 1024px sheet's are ~20px tall) is the same sub-pixel argument as
 * the tracer's `traceScale`: the anti-aliasing carries shape the recognizer can
 * use once the lattice is fine enough.
 */
export function prepareCaption(image: ImageDataLike, ink: Rect, bg: SheetBackground): ImageDataLike {
  const pad = Math.max(8, Math.round(ink.h * CAPTION_PAD))
  const rect = { x: ink.x - pad, y: ink.y - pad, w: ink.w + 2 * pad, h: ink.h + 2 * pad }
  const fill = bg.transparent ? { r: 0, g: 0, b: 0, a: 0 } : { r: bg.r, g: bg.g, b: bg.b, a: 255 }
  const crop = cropTile(image, rect, fill)
  const paperLuma = bg.transparent ? 255 : luma(bg.r, bg.g, bg.b)
  const invert = paperLuma < 128

  const { width: w, height: h, data } = crop
  const grey = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    const o = i * 4
    let v: number
    if (bg.transparent) {
      v = 255 - data[o + 3]
    } else {
      v = luma(data[o], data[o + 1], data[o + 2])
      if (invert) v = 255 - v
    }
    grey[o] = v
    grey[o + 1] = v
    grey[o + 2] = v
    grey[o + 3] = 255
  }
  blur121(grey, w, h)
  const scale = Math.max(1, Math.min(MAX_CAPTION_SCALE, Math.round(CAPTION_TARGET_H / Math.max(1, ink.h))))
  return upscaleImageData({ width: w, height: h, data: grey }, scale)
}

/**
 * A [1 2 1]/4 blur, separable, in place on a grey RGBA buffer.
 *
 * Sheets arrive JPEG/WebP-compressed, and the ringing on a glyph's edge is
 * enough to turn a "g" into a "Q" for the recognizer: at native 2048px the
 * weather example read "Fog" as "FOQ" at 65% confidence, while the same sheet
 * downscaled to 1024 (smoothed by the resample, then enlarged) read fine. One
 * light blur pass gives the native crop the same smoothness — measured over the
 * 28 captions of the two captioned examples at 2048, 1024 and 768px: every
 * caption at ≥ 90% confidence with it, one misread without. Showing the OCR a
 * LARGER crop instead (target 96px) made every read less confident.
 */
function blur121(px: Uint8ClampedArray, w: number, h: number): void {
  const tmp = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) {
      const l = row + Math.max(0, x - 1)
      const r = row + Math.min(w - 1, x + 1)
      tmp[row + x] = (px[l * 4] + 2 * px[(row + x) * 4] + px[r * 4]) / 4
    }
  }
  for (let y = 0; y < h; y++) {
    const up = Math.max(0, y - 1) * w
    const down = Math.min(h - 1, y + 1) * w
    const row = y * w
    for (let x = 0; x < w; x++) {
      const v = (tmp[up + x] + 2 * tmp[row + x] + tmp[down + x]) / 4
      const o = (row + x) * 4
      px[o] = v
      px[o + 1] = v
      px[o + 2] = v
    }
  }
}

/** Rec.709 luma — the same weights the ink probe uses. */
function luma(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
