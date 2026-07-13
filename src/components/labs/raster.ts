/** Encode an RGBA buffer as a data URL. Was hand-rolled in both goldenView and truthView. */
export function rgbaToUrl(px: Uint8ClampedArray, w: number, h: number): string {
  const cv = document.createElement('canvas')
  cv.width = w
  cv.height = h
  const ctx = cv.getContext('2d')
  if (!ctx) throw new Error('no 2d context')
  // Fill a canvas-owned ImageData rather than `new ImageData(px, …)`: our buffers are
  // plain Uint8ClampedArrays, which the DOM constructor's ArrayBuffer-narrowed type
  // rejects.
  const id = ctx.createImageData(w, h)
  id.data.set(px)
  ctx.putImageData(id, 0, 0)
  return cv.toDataURL('image/png')
}
