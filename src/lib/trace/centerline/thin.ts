// Skeletonization: the ink mask thinned to a one-pixel-wide, 8-connected skeleton.
//
// Zhang–Suen (1984) — two sub-iterations that peel boundary pixels from alternating
// sides until nothing changes — followed by a simple-point cleanup that strips every
// pixel whose removal keeps the topology (Yokoi's connectivity number), which is what a
// Zhang–Suen skeleton is missing: its diagonal runs keep a two-pixel elbow on every
// step, and graph.ts would read each elbow as a junction with a one-pixel chain.
//
// Pure, deterministic, and only a starting point: the medial axis is where the centre
// of a stroke is looked for, not where it is — profile.ts re-centres every skeleton
// pixel on the ink's coverage profile, and graph.ts prunes the spurs thinning grows at
// every corner and cap.

/**
 * Thin `mask` (1 = ink) in place-safe fashion, returning a new 0/1 skeleton mask. Border
 * pixels are never skeleton (the 3×3 neighbourhood must be inside the raster).
 */
export function thinZhangSuen(mask: Uint8Array, width: number, height: number): Uint8Array {
  const s = new Uint8Array(mask.length)
  for (let i = 0; i < mask.length; i++) s[i] = mask[i] ? 1 : 0
  // The border row and column read as paper: a pixel there has no full neighbourhood to
  // test, and ink touching the frame is then peeled from the frame side like any edge.
  for (let x = 0; x < width; x++) s[x] = s[(height - 1) * width + x] = 0
  for (let y = 0; y < height; y++) s[y * width] = s[y * width + width - 1] = 0
  const w = width
  const del: number[] = []
  for (;;) {
    let changed = false
    for (let pass = 0; pass < 2; pass++) {
      del.length = 0
      for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const i = y * w + x
          if (!s[i]) continue
          // P2..P9 clockwise from the top.
          const p2 = s[i - w]
          const p3 = s[i - w + 1]
          const p4 = s[i + 1]
          const p5 = s[i + w + 1]
          const p6 = s[i + w]
          const p7 = s[i + w - 1]
          const p8 = s[i - 1]
          const p9 = s[i - w - 1]
          const b = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9
          if (b < 3 || b > 6) continue
          // Transitions 0→1 around the ring.
          let a = 0
          if (!p2 && p3) a++
          if (!p3 && p4) a++
          if (!p4 && p5) a++
          if (!p5 && p6) a++
          if (!p6 && p7) a++
          if (!p7 && p8) a++
          if (!p8 && p9) a++
          if (!p9 && p2) a++
          if (a !== 1) continue
          if (pass === 0) {
            if (p2 * p4 * p6 !== 0 || p4 * p6 * p8 !== 0) continue
          } else if (p2 * p4 * p8 !== 0 || p2 * p6 * p8 !== 0) continue
          del.push(i)
        }
      }
      if (del.length) {
        changed = true
        for (const i of del) s[i] = 0
      }
    }
    if (!changed) break
  }
  removeSimplePoints(s, width, height)
  return s
}

/**
 * Yokoi's 8-connectivity number of a foreground pixel: how many 8-connected components
 * of foreground its eight neighbours form, counting a diagonal as linking the two
 * orthogonals beside it. 0 isolated, 1 an end (or a removable point), 2 a run, ≥3 a
 * junction. `s` is the 0/1 image, `i` an interior pixel index.
 */
export function connectivity8(s: Uint8Array, i: number, w: number): number {
  // Neighbours in order E, NE, N, NW, W, SW, S, SE, as complements (1 = background).
  const n = [
    1 - s[i + 1],
    1 - s[i - w + 1],
    1 - s[i - w],
    1 - s[i - w - 1],
    1 - s[i - 1],
    1 - s[i + w - 1],
    1 - s[i + w],
    1 - s[i + w + 1],
  ]
  let c = 0
  for (const k of [0, 2, 4, 6]) c += n[k] - n[k] * n[(k + 1) % 8] * n[(k + 2) % 8]
  return c
}

/**
 * Remove every simple point that is not an end, to a fixpoint: a pixel with at least
 * two skeleton neighbours whose neighbours form ONE 8-connected component can go
 * without changing the topology (Yokoi: connectivity number 1). This is what makes the
 * Zhang–Suen result strictly thin — its diagonal runs keep two-pixel elbows on every
 * step, and each elbow pixel reads as a three-neighbour junction to any graph walker.
 * Removal is in place, in scan order, so every test sees the current image and no two
 * adjacent removals can break a line.
 */
function removeSimplePoints(s: Uint8Array, width: number, height: number): void {
  const w = width
  for (;;) {
    let removed = 0
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x
        if (!s[i]) continue
        const count =
          s[i - w] + s[i - w + 1] + s[i + 1] + s[i + w + 1] + s[i + w] + s[i + w - 1] + s[i - 1] + s[i - w - 1]
        if (count < 2) continue
        if (connectivity8(s, i, w) !== 1) continue
        s[i] = 0
        removed++
      }
    }
    if (removed === 0) break
  }
}
