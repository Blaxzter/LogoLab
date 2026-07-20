import { serializeDoc, subPathsToD } from '../../lib/path/model'
import type { EditableDoc, SubPath } from '../../lib/path/types'

/**
 * The nodes/edges wireframe of the planar shared-edge graph, as an SVG `<g>`: every
 * shared edge stroked once, an anchor dot per node (square = corner, round = smooth),
 * a ring per junction vertex. Node and junction COUNTS are gated, so this is the
 * structure those numbers are counting.
 *
 * Every marker uses `vector-effect: non-scaling-stroke` (see labs.css), so a dot stays the
 * SAME screen size at any zoom — a 5px dot at 100% is a 5px dot at 4000%. That is the whole
 * point of the overlay: you zoom in to see EXACTLY where a node sits, and a marker that grew
 * with the art would just smear over the very spot you are trying to read.
 *
 * It ships inside every trace panel but stays hidden until the toolbar toggle puts
 * `.wires` on the lab root — flipping the overlay needs no re-trace. Was duplicated verbatim
 * in goldenView and junctionTest.
 */
export function wireGroup(doc: EditableDoc): string {
  const t = doc.topology
  if (!t || t.edges.length === 0) return ''
  const f = (n: number): string => n.toFixed(2)
  let edges = ''
  let corners = ''
  let smooths = ''
  let verts = ''
  for (const e of t.edges) {
    edges += `<path d="${subPathsToD([{ nodes: e.nodes, closed: e.closed }], 2)}"/>`
    for (const n of e.nodes) {
      const dot = `<line x1="${f(n.x)}" y1="${f(n.y)}" x2="${f(n.x)}" y2="${f(n.y)}"/>`
      if (n.kind === 'corner') corners += dot
      else smooths += dot
    }
  }
  for (const v of t.vertices) {
    const at = `x1="${f(v.x)}" y1="${f(v.y)}" x2="${f(v.x)}" y2="${f(v.y)}"`
    verts += `<line class="v-out" ${at}/><line class="v-in" ${at}/>`
  }
  return `<g class="lab-wire"><g class="w-edge">${edges}</g><g class="w-corner">${corners}</g><g class="w-smooth">${smooths}</g><g class="w-vert">${verts}</g></g>`
}

/**
 * The same nodes wireframe as {@link wireGroup}, but from plain subpaths — for art that
 * has no planar topology, i.e. the AUTHORED ground truth. Every subpath is stroked as an
 * edge and each node gets an anchor dot (square = corner, round = smooth). No junction
 * rings: authored art is a set of independent paths, not a shared-edge graph. It emits the
 * identical `.lab-wire` markup, so the same `.wires` toggle reveals it — and the same
 * constant-screen-size markers — with no re-trace.
 */
export function subPathsWire(sets: SubPath[][]): string {
  const f = (n: number): string => n.toFixed(2)
  let edges = ''
  let corners = ''
  let smooths = ''
  for (const set of sets) {
    for (const sp of set) {
      if (sp.nodes.length === 0) continue
      edges += `<path d="${subPathsToD([sp], 2)}"/>`
      for (const n of sp.nodes) {
        const dot = `<line x1="${f(n.x)}" y1="${f(n.y)}" x2="${f(n.x)}" y2="${f(n.y)}"/>`
        if (n.kind === 'corner') corners += dot
        else smooths += dot
      }
    }
  }
  if (edges === '') return ''
  return `<g class="lab-wire"><g class="w-edge">${edges}</g><g class="w-corner">${corners}</g><g class="w-smooth">${smooths}</g></g>`
}

/** A traced doc as panel art: the fill (dimmed when the wireframe is on) plus the
 *  wireframe overlay, in one SVG. With wires off it renders exactly like the fill. */
export function traceSvg(doc: EditableDoc, w: number, h: number): string {
  const inner = serializeDoc(doc, 2)
    .replace(/^<svg[^>]*>/, '')
    .replace(/<\/svg>\s*$/, '')
  return `<svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg"><g class="lab-fill">${inner}</g>${wireGroup(doc)}</svg>`
}

/** Counts a lab shows under a trace panel. */
export function docStats(doc: EditableDoc): { paths: number; nodes: number; edges: number; junctions: number } {
  let paths = 0
  let nodes = 0
  for (const it of doc.items) {
    if (it.kind !== 'path') continue
    paths++
    for (const sp of it.subPaths) nodes += sp.nodes.length
  }
  return {
    paths,
    nodes,
    edges: doc.topology?.edges.length ?? 0,
    junctions: doc.topology?.vertices.length ?? 0,
  }
}
