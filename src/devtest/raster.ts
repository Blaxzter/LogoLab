// The pure EditableDoc→RGBA rasterizer now lives in src/lib/render/raster.ts so
// it is a first-class library capability (the V6 decomposition gate rasterizes
// candidate docs through the SAME renderer the harness scores with — so the gate
// measures exactly what will be emitted). This shim re-exports it unchanged for
// the devtest harness's existing imports.
export { rasterizeDoc, flattenItem, boundaryMask, parseHex, type RasterOptions } from '../lib/render/raster.ts'
