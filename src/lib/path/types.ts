// Editable vector document model — the shared shape between the tracing
// pipeline, the node editor, and SVG import/export.
//
// All coordinates are absolute, in viewBox units. Cubic Béziers only: every
// curve segment between two nodes is defined by the first node's `hOut` and
// the second node's `hIn`; a null handle collapses onto its anchor (straight
// line when both ends are null).

export interface Vec {
  x: number
  y: number
}

/** How a node joins its two segments: free corner, or collinear handles. */
export type NodeKind = 'corner' | 'smooth'

export interface PathNode {
  /** Anchor point. */
  x: number
  y: number
  /** Incoming Bézier control point (absolute), or null = straight toward anchor. */
  hIn: Vec | null
  /** Outgoing Bézier control point (absolute), or null = straight away from anchor. */
  hOut: Vec | null
  kind: NodeKind
}

export interface SubPath {
  nodes: PathNode[]
  closed: boolean
}

/** A fillable, node-editable path (possibly compound — holes via subpaths). */
export interface PathItem {
  kind: 'path'
  id: string
  fill: string
  /** 0–1; omitted means 1. */
  fillOpacity?: number
  /** Only 'evenodd' is ever serialized; nonzero is the SVG default. */
  fillRule: 'nonzero' | 'evenodd'
  subPaths: SubPath[]
  /** Editor-only: hidden items render nowhere and are excluded from export. */
  visible: boolean
}

/**
 * Verbatim markup the editor can't model (gradients, strokes, text, defs…).
 * Round-trips untouched so importing a hand-made SVG stays lossless. The
 * composed group context it was lifted out of is captured alongside.
 */
export interface RawItem {
  kind: 'raw'
  id: string
  markup: string
  /** Composed `transform` attribute value inherited from ancestor groups. */
  transform?: string
  /** Inherited presentation attributes lost by flattening (fill, stroke…). */
  inherited?: Record<string, string>
  visible: boolean
}

export type DocItem = PathItem | RawItem

export interface EditableDoc {
  /** [minX, minY, width, height] */
  viewBox: [number, number, number, number]
  /** Paint order: first = bottom. */
  items: DocItem[]
}

/** Stable reference to one node inside a PathItem. */
export interface NodeRef {
  /** Index into PathItem.subPaths. */
  sub: number
  /** Index into SubPath.nodes. */
  idx: number
}

/** Row-major 2D affine transform: [a, b, c, d, e, f] as in SVG matrix(). */
export type Affine = [number, number, number, number, number, number]
