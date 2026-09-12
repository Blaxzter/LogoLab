// Artboard sizes for a new blank drawing.
//
// The document model has no unit system — a viewBox is bare numbers (see
// lib/path/types.ts), and `serializeDoc` writes no width/height attributes. So
// a "paper" preset can only mean one thing honestly: the size in CSS pixels
// that PRINTS as that sheet, i.e. the millimetres converted at 96 dpi, which is
// the ratio a browser fixes between a user unit and a physical inch. A4 is then
// 794 × 1123, and anything laid out on it comes out at 210 × 297 mm.

/** The browser's fixed user-unit-to-inch ratio. */
const DPI = 96
const MM_PER_IN = 25.4

/** Millimetres → artboard units. */
const mm = (v: number) => Math.round((v / MM_PER_IN) * DPI)
/** Inches → artboard units. */
const inch = (v: number) => Math.round(v * DPI)

export interface ArtboardPreset {
  id: string
  /** What the button says. */
  label: string
  /** Where the number comes from — the tooltip's second line. */
  note: string
  /** Portrait (or square) orientation; the picker flips it on request. */
  width: number
  height: number
}

/** Square artboards: what an icon or a logo is actually drawn on. */
export const SQUARE_PRESETS: ArtboardPreset[] = [
  { id: 'sq256', label: '256', note: 'A small icon — the size a favicon or a toolbar glyph ends up at.', width: 256, height: 256 },
  { id: 'sq512', label: '512', note: 'The usual app-icon master. Big enough to draw on, small enough to reason about.', width: 512, height: 512 },
  { id: 'sq1024', label: '1024', note: 'A large master — iOS ships its icon at this size.', width: 1024, height: 1024 },
]

/** Paper artboards, portrait. Units print as the named sheet at 96 dpi. */
export const PAPER_PRESETS: ArtboardPreset[] = [
  { id: 'a5', label: 'A5', note: '148 × 210 mm — half an A4.', width: mm(148), height: mm(210) },
  { id: 'a4', label: 'A4', note: '210 × 297 mm — the standard sheet outside North America.', width: mm(210), height: mm(297) },
  { id: 'a3', label: 'A3', note: '297 × 420 mm — a poster, or two A4s side by side.', width: mm(297), height: mm(420) },
  { id: 'letter', label: 'Letter', note: '8.5 × 11 in — the standard sheet in North America.', width: inch(8.5), height: inch(11) },
  { id: 'legal', label: 'Legal', note: '8.5 × 14 in — a long US sheet.', width: inch(8.5), height: inch(14) },
]

/** Smallest and largest artboard a free field accepts. */
export const MIN_ARTBOARD = 16
export const MAX_ARTBOARD = 8192

/** A preset matches the current size in EITHER orientation. */
export function presetMatches(p: ArtboardPreset, width: number, height: number): boolean {
  return (p.width === width && p.height === height) || (p.width === height && p.height === width)
}

/**
 * What a size IS, next to the numbers themselves — so it never repeats them.
 * A paper preset is worth naming ("A4 portrait"); a square one is already its
 * own measurement, and says only that it is square.
 */
export function describeArtboard(width: number, height: number): string {
  const shape = width === height ? 'Square' : width > height ? 'Landscape' : 'Portrait'
  const paper = PAPER_PRESETS.find((p) => presetMatches(p, width, height))
  return paper ? `${paper.label} ${shape.toLowerCase()}` : shape
}
