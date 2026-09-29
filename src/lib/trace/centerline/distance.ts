// Exact Euclidean distance transform (Felzenszwalb & Huttenlocher 2012): for every ink
// pixel, the distance from its centre to the nearest paper pixel's centre. Two separable
// 1-D lower-envelope passes, O(n). Paper pixels read 0.
//
// The half-width of a stroke through a skeleton pixel is `dt − 0.5`: a run of n ink
// pixels has its centre pixel at distance ceil(n/2) from the nearest paper centre, and
// the stroke's true half-width is n/2. (The sub-pixel profile in profile.ts measures the
// width properly from the anti-aliasing; this is the first estimate, and the radius the
// blob split and the spur pruning read.)

const INF = 1e20

/** Distance to the nearest zero of `mask` (1 = ink), per pixel; paper is 0. */
export function distanceTransform(mask: Uint8Array, width: number, height: number): Float32Array {
  const n = width * height
  const f = new Float32Array(n)
  for (let i = 0; i < n; i++) f[i] = mask[i] ? INF : 0
  const longest = Math.max(width, height)
  const line = new Float32Array(longest)
  const out = new Float32Array(longest)
  const v = new Int32Array(longest)
  const z = new Float32Array(longest + 1)
  // Columns.
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) line[y] = f[y * width + x]
    edt1d(line, height, out, v, z)
    for (let y = 0; y < height; y++) f[y * width + x] = out[y]
  }
  // Rows.
  for (let y = 0; y < height; y++) {
    const row = y * width
    for (let x = 0; x < width; x++) line[x] = f[row + x]
    edt1d(line, width, out, v, z)
    for (let x = 0; x < width; x++) f[row + x] = Math.sqrt(out[x])
  }
  return f
}

/** Squared-distance transform of one line (`f` holds squared distances in, `out` out). */
function edt1d(f: Float32Array, n: number, out: Float32Array, v: Int32Array, z: Float32Array): void {
  let k = 0
  v[0] = 0
  z[0] = -INF
  z[1] = INF
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
    while (s <= z[k]) {
      k--
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
    }
    k++
    v[k] = q
    z[k] = s
    z[k + 1] = INF
  }
  k = 0
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++
    const d = q - v[k]
    out[q] = d * d + f[v[k]]
  }
}
