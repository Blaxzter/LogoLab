// User region markers: snap to a smooth pixel, then marker-controlled seeded region growing.

/**
 * How far (Chebyshev px) a marker may snap to reach a smooth pixel. A fraction of the
 * image, because markers arrive in normalized coordinates and the same marker must
 * reach the same artwork at every resolution. The floor is in pixels because a
 * discontinuity band is a few px wide at any resolution.
 */
export const MARKER_SNAP_FRAC = 1 / 8
export const MARKER_SNAP_MIN = 8
export function markerSnapRadius(w: number, h: number): number {
  return Math.min(Math.max(w, h), Math.max(MARKER_SNAP_MIN, Math.round(Math.max(w, h) * MARKER_SNAP_FRAC)))
}

/**
 * Nearest smooth pixel to (px,py) by an expanding Chebyshev-ring scan (fixed
 * order ⇒ deterministic). Returns its index, or −1 if none is within
 * `markerSnapRadius`. A marker dropped on a discontinuity or transparent pixel
 * snaps to the closest real segment; a badly misplaced one becomes a no-op.
 */
export function nearestSmoothPixel(smooth: Uint8Array, w: number, h: number, px: number, py: number): number {
  if (smooth[py * w + px]) return py * w + px
  const maxR = markerSnapRadius(w, h)
  for (let r = 1; r <= maxR; r++) {
    const x0 = px - r
    const x1 = px + r
    const y0 = py - r
    const y1 = py + r
    for (let x = x0; x <= x1; x++) {
      if (x < 0 || x >= w) continue
      if (y0 >= 0 && smooth[y0 * w + x]) return y0 * w + x
      if (y1 < h && smooth[y1 * w + x]) return y1 * w + x
    }
    for (let y = y0 + 1; y <= y1 - 1; y++) {
      if (y < 0 || y >= h) continue
      if (x0 >= 0 && smooth[y * w + x0]) return y * w + x0
      if (x1 < w && smooth[y * w + x1]) return y * w + x1
    }
  }
  return -1
}

// ---------------------------------------------------------------------------
// Marker-controlled seeded region growing (Adams & Bischof, 1994): grow each
// seed's region by repeatedly claiming the unassigned boundary pixel most similar
// to a region's running mean (a priority queue), so the boundary settles on the
// colour ridge between regions. Works even when the regions' mean colours are
// within the global merge threshold and the step is subtle.
// ---------------------------------------------------------------------------

/**
 * Split every macro-region holding ≥2 markers, growing one sub-region per marker.
 * Mutates `groupId` in place (sub-region 0 keeps the group's id, the rest get new
 * ids ≥ GG0) and returns the new total group count. Deterministic: groups and
 * seeds are processed in ascending / input order; heap ties break by pixel index.
 */
export function markerControlledSplit(
  groupId: Int32Array,
  GG0: number,
  markerSeeds: number[],
  w: number,
  h: number,
  labL: Float64Array,
  labA: Float64Array,
  labB: Float64Array,
): number {
  const byGroup = new Map<number, number[]>()
  for (const seed of markerSeeds) {
    const g = groupId[seed]
    if (g < 0) continue
    const list = byGroup.get(g)
    if (list) list.push(seed)
    else byGroup.set(g, [seed])
  }
  const toSplit = [...byGroup.keys()].filter((g) => byGroup.get(g)!.length >= 2).sort((a, b) => a - b)
  if (toSplit.length === 0) return GG0

  const sub = new Int32Array(groupId.length).fill(-1) // per-pixel sub-region (reused)
  let nextGroup = GG0
  for (const g of toSplit) {
    const seeds = byGroup.get(g)!
    const subIds = seeds.map((_, i) => (i === 0 ? g : nextGroup++))
    growSeeds(groupId, g, seeds, subIds, sub, w, h, labL, labA, labB)
  }
  return nextGroup
}

/** Grow `seeds` over the pixels currently labelled `g`, writing their final group
 *  ids (`subIds`) into `groupId`. `sub` is scratch (size = #px), reset on return. */
function growSeeds(
  groupId: Int32Array,
  g: number,
  seeds: number[],
  subIds: number[],
  sub: Int32Array,
  w: number,
  h: number,
  labL: Float64Array,
  labA: Float64Array,
  labB: Float64Array,
): void {
  const K = seeds.length
  const sumL = new Float64Array(K)
  const sumA = new Float64Array(K)
  const sumB = new Float64Array(K)
  const cnt = new Float64Array(K)
  const heap = new MinHeap()
  const touched: number[] = []

  const meanDE = (pix: number, k: number): number => {
    const dl = labL[pix] - sumL[k] / cnt[k]
    const da = labA[pix] - sumA[k] / cnt[k]
    const db = labB[pix] - sumB[k] / cnt[k]
    return Math.sqrt(dl * dl + da * da + db * db)
  }
  const pushNbrs = (pix: number, k: number): void => {
    const x = pix % w
    const y = (pix / w) | 0
    if (x > 0 && groupId[pix - 1] === g && sub[pix - 1] === -1) heap.push(meanDE(pix - 1, k), pix - 1, k)
    if (x < w - 1 && groupId[pix + 1] === g && sub[pix + 1] === -1) heap.push(meanDE(pix + 1, k), pix + 1, k)
    if (y > 0 && groupId[pix - w] === g && sub[pix - w] === -1) heap.push(meanDE(pix - w, k), pix - w, k)
    if (y < h - 1 && groupId[pix + w] === g && sub[pix + w] === -1) heap.push(meanDE(pix + w, k), pix + w, k)
  }

  for (let k = 0; k < K; k++) {
    const s = seeds[k]
    sub[s] = k
    touched.push(s)
    sumL[k] = labL[s]
    sumA[k] = labA[s]
    sumB[k] = labB[s]
    cnt[k] = 1
  }
  for (let k = 0; k < K; k++) pushNbrs(seeds[k], k)

  while (heap.size > 0) {
    const pix = heap.pop()
    const k = heap.popReg
    if (sub[pix] !== -1) continue // already claimed by an earlier (lower-ΔE) pop
    sub[pix] = k
    touched.push(pix)
    sumL[k] += labL[pix]
    sumA[k] += labA[pix]
    sumB[k] += labB[pix]
    cnt[k]++
    pushNbrs(pix, k)
  }

  // Write final ids; any pixel of g the growth didn't reach (a component with no
  // seed) stays in sub-region 0 (= g). Reset the touched scratch for the next group.
  for (let i = 0; i < groupId.length; i++) {
    if (groupId[i] !== g) continue
    const k = sub[i]
    groupId[i] = subIds[k < 0 ? 0 : k]
  }
  for (const p of touched) sub[p] = -1
}

/** Binary min-heap of (ΔE, pixel, region) entries, ordered by ΔE then pixel index
 *  then region (a total order ⇒ deterministic region growing). `pop()` returns the
 *  pixel and exposes its region via `popReg`. */
class MinHeap {
  de: number[] = []
  pix: number[] = []
  reg: number[] = []
  size = 0
  popReg = 0
  push(de: number, pix: number, reg: number): void {
    const i = this.size++
    this.de[i] = de
    this.pix[i] = pix
    this.reg[i] = reg
    this.up(i)
  }
  pop(): number {
    const pix = this.pix[0]
    this.popReg = this.reg[0]
    const last = --this.size
    this.de[0] = this.de[last]
    this.pix[0] = this.pix[last]
    this.reg[0] = this.reg[last]
    if (this.size > 0) this.down(0)
    return pix
  }
  less(i: number, j: number): boolean {
    if (this.de[i] !== this.de[j]) return this.de[i] < this.de[j]
    if (this.pix[i] !== this.pix[j]) return this.pix[i] < this.pix[j]
    return this.reg[i] < this.reg[j]
  }
  swap(i: number, j: number): void {
    const d = this.de[i]; this.de[i] = this.de[j]; this.de[j] = d
    const p = this.pix[i]; this.pix[i] = this.pix[j]; this.pix[j] = p
    const r = this.reg[i]; this.reg[i] = this.reg[j]; this.reg[j] = r
  }
  up(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (!this.less(i, parent)) break
      this.swap(i, parent)
      i = parent
    }
  }
  down(i: number): void {
    for (;;) {
      const l = 2 * i + 1
      const r = 2 * i + 2
      let m = i
      if (l < this.size && this.less(l, m)) m = l
      if (r < this.size && this.less(r, m)) m = r
      if (m === i) break
      this.swap(i, m)
      i = m
    }
  }
}
