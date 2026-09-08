// Icon-sheet splitting — public surface.
export { detectSheetIcons, gridTiles, estimateBackground, isInkPixel, DETECT_DEFAULTS } from './detect.ts'
export { cropTile, downscaleImageData, upscaleImageData, toImageData, defaultTileName, nameStem } from './crop.ts'
export type { CropFill } from './crop.ts'
export { probeInk } from '../ink.ts'
export type { InkProbe } from '../ink.ts'
export { matchCaptions, captionToName, cleanAffix, exportName, prepareCaption } from './captions.ts'
export type { CaptionMatch } from './captions.ts'
export type {
  DetectOptions,
  ImageDataLike,
  Rect,
  SheetBackground,
  SheetDetection,
  SheetGrid,
  SheetTile,
  TileKind,
} from './types'
