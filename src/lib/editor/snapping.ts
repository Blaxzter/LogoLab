// Snapping: grid, other geometry, and the artboard.
//
// The two axes snap independently (passing another node's x snaps x and leaves
// y alone). Each axis reports the candidate it locked onto so the canvas can
// draw the matching guide.
//
// Tolerances are in viewBox units, already divided by the zoom by the caller.

import type { DocItem, Vec } from '../path/types.ts'
import { allLeaves } from '../path/docTree.ts'
import type { Box } from './transform.ts'
import { itemBox } from './transform.ts'

/**
 * What kind of feature a candidate is, and what a probe is looking for. Box
 * snapping matches like for like (edge to edge, centre to centre); a centre
 * landing on an edge reads as an unexplained jump. Point snapping (a node
 * drag) ignores roles.
 */
export type SnapRole = 'edge' | 'center'

/** One thing an axis can snap to, with the line to draw when it does. */
export interface SnapCandidate {
  /** Coordinate on the snapping axis. */
  value: number
  /** What produced it — drives the guide's styling. */
  source: 'grid' | 'anchor' | 'edge' | 'center' | 'artboard'
  /** Which probe kind may match it. */
  role: SnapRole
  /**
   * Extent of the source along the other axis, so the guide can span from the
   * dragged point to its partner. Absent for grid/artboard.
   */
  from?: number
  to?: number
}

export interface SnapAxisResult {
  value: number
  hit: SnapCandidate | null
}

export interface SnapResult {
  point: Vec
  x: SnapCandidate | null
  y: SnapCandidate | null
}

export interface SnapConfig {
  /** Master switch; false returns the input untouched. */
  enabled: boolean
  /** Grid pitch in viewBox units. 0 disables grid snapping. */
  grid: number
  /** Snap to other items' anchors and box edges. */
  toGeometry: boolean
  /** Snap to the artboard's edges and centre lines. */
  toArtboard: boolean
  /** Slack in viewBox units. */
  tolerance: number
}

export const DEFAULT_SNAP: SnapConfig = {
  enabled: true,
  grid: 8,
  toGeometry: true,
  toArtboard: true,
  tolerance: 6,
}

/**
 * Candidate coordinates on each axis, gathered once per drag (the geometry
 * can't change mid-drag) rather than per pointermove.
 */
export interface SnapTargets {
  xs: SnapCandidate[]
  ys: SnapCandidate[]
}

export const NO_TARGETS: SnapTargets = { xs: [], ys: [] }

/**
 * Collect snap candidates from everything except the items being dragged;
 * otherwise a shape would stick to its own start position.
 */
export function collectTargets(
  items: readonly DocItem[],
  viewBox: readonly [number, number, number, number],
  excludeIds: ReadonlySet<string>,
  cfg: SnapConfig,
): SnapTargets {
  const xs: SnapCandidate[] = []
  const ys: SnapCandidate[] = []
  if (!cfg.enabled) return { xs, ys }

  if (cfg.toArtboard) {
    const [vx, vy, vw, vh] = viewBox
    xs.push({ value: vx, source: 'artboard', role: 'edge' })
    xs.push({ value: vx + vw / 2, source: 'artboard', role: 'center' })
    xs.push({ value: vx + vw, source: 'artboard', role: 'edge' })
    ys.push({ value: vy, source: 'artboard', role: 'edge' })
    ys.push({ value: vy + vh / 2, source: 'artboard', role: 'center' })
    ys.push({ value: vy + vh, source: 'artboard', role: 'edge' })
  }

  if (cfg.toGeometry) {
    for (const leaf of allLeaves(items)) {
      if (excludeIds.has(leaf.id) || !leaf.visible) continue
      const box = itemBox(leaf)
      if (!box) continue
      const y0 = box.y
      const y1 = box.y + box.h
      const x0 = box.x
      const x1 = box.x + box.w
      xs.push({ value: x0, source: 'edge', role: 'edge', from: y0, to: y1 })
      xs.push({ value: x1, source: 'edge', role: 'edge', from: y0, to: y1 })
      xs.push({ value: x0 + box.w / 2, source: 'center', role: 'center', from: y0, to: y1 })
      ys.push({ value: y0, source: 'edge', role: 'edge', from: x0, to: x1 })
      ys.push({ value: y1, source: 'edge', role: 'edge', from: x0, to: x1 })
      ys.push({ value: y0 + box.h / 2, source: 'center', role: 'center', from: x0, to: x1 })

      // Anchors, so a node drag can land exactly on a neighbouring node.
      if (leaf.kind === 'path') {
        for (const sp of leaf.subPaths) {
          for (const node of sp.nodes) {
            xs.push({ value: node.x, source: 'anchor', role: 'edge', from: node.y, to: node.y })
            ys.push({ value: node.y, source: 'anchor', role: 'edge', from: node.x, to: node.x })
          }
        }
      }
    }
  }
  return { xs, ys }
}

/**
 * Resolve one axis: nearest candidate within tolerance, else the grid.
 * `role` restricts which candidates may match; null accepts any.
 */
function snapAxis(
  v: number,
  candidates: readonly SnapCandidate[],
  cfg: SnapConfig,
  role: SnapRole | null = null,
): SnapAxisResult {
  let best: SnapCandidate | null = null
  let bestD = cfg.tolerance
  for (const c of candidates) {
    if (role !== null && c.role !== role) continue
    const d = Math.abs(c.value - v)
    // Strictly-nearer wins, so ties go to the earlier candidate; geometry is
    // collected before the artboard, so visible shapes win ties.
    if (d < bestD || (best === null && d <= bestD)) {
      bestD = d
      best = c
    }
  }
  if (best) return { value: best.value, hit: best }

  if (cfg.grid > 0) {
    const g = Math.round(v / cfg.grid) * cfg.grid
    if (Math.abs(g - v) <= cfg.tolerance) {
      return { value: g, hit: { value: g, source: 'grid', role: role ?? 'edge' } }
    }
  }
  return { value: v, hit: null }
}

/** Snap a point on both axes independently. */
export function snapPoint(p: Vec, targets: SnapTargets, cfg: SnapConfig): SnapResult {
  if (!cfg.enabled) return { point: p, x: null, y: null }
  const sx = snapAxis(p.x, targets.xs, cfg)
  const sy = snapAxis(p.y, targets.ys, cfg)
  return { point: { x: sx.value, y: sy.value }, x: sx.hit, y: sy.hit }
}

/**
 * Snap a drag delta by testing the moving box's edges and centre against the
 * targets and taking the smallest correction. The box is snapped, not the
 * pointer, so the shape's own edge is what lands on the guide.
 */
export function snapBoxDelta(
  box: Box,
  delta: Vec,
  targets: SnapTargets,
  cfg: SnapConfig,
): { delta: Vec; x: SnapCandidate | null; y: SnapCandidate | null } {
  if (!cfg.enabled) return { delta, x: null, y: null }

  // Each probe carries the role it is allowed to match, so the leading and
  // trailing edges look for edges and the centre looks for centres.
  const probeX: [number, SnapRole][] = [
    [box.x + delta.x, 'edge'],
    [box.x + box.w / 2 + delta.x, 'center'],
    [box.x + box.w + delta.x, 'edge'],
  ]
  const probeY: [number, SnapRole][] = [
    [box.y + delta.y, 'edge'],
    [box.y + box.h / 2 + delta.y, 'center'],
    [box.y + box.h + delta.y, 'edge'],
  ]

  const bestAxis = (
    probes: [number, SnapRole][],
    candidates: readonly SnapCandidate[],
  ): { adj: number; hit: SnapCandidate | null } => {
    let adj = 0
    let hit: SnapCandidate | null = null
    let bestAbs = Infinity
    for (const [v, role] of probes) {
      const r = snapAxis(v, candidates, cfg, role)
      if (!r.hit) continue
      const a = r.value - v
      if (Math.abs(a) < bestAbs) {
        bestAbs = Math.abs(a)
        adj = a
        hit = r.hit
      }
    }
    return { adj, hit }
  }

  const rx = bestAxis(probeX, targets.xs)
  const ry = bestAxis(probeY, targets.ys)
  return { delta: { x: delta.x + rx.adj, y: delta.y + ry.adj }, x: rx.hit, y: ry.hit }
}

/** Constrain a delta to the dominant axis (Shift-drag). */
export function axisLock(delta: Vec): Vec {
  return Math.abs(delta.x) >= Math.abs(delta.y)
    ? { x: delta.x, y: 0 }
    : { x: 0, y: delta.y }
}

/**
 * Arrow-key step: 1 unit, Shift = 10×, Alt = 0.1×.
 */
export function nudgeStep(
  base: number,
  mods: { shift?: boolean; alt?: boolean },
): number {
  if (mods.shift) return base * 10
  if (mods.alt) return base / 10
  return base
}
