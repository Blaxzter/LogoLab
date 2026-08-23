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

/** One color stop of a gradient fill. */
export interface GradientStop {
  /** Position along the gradient axis, 0–1. */
  offset: number
  /** Stop color as #rrggbb. */
  color: string
  /** 0–1; omitted means 1. */
  opacity?: number
}

/**
 * A linear gradient fill. Endpoints are in absolute viewBox units (SVG
 * `gradientUnits="userSpaceOnUse"`), so the gradient transforms in lockstep
 * with the path nodes during edit / zoom — no bounding-box recomputation.
 */
export interface LinearGradient {
  type: 'linear'
  x1: number
  y1: number
  x2: number
  y2: number
  stops: GradientStop[]
}

/** A radial gradient fill, in absolute viewBox units (userSpaceOnUse). */
export interface RadialGradient {
  type: 'radial'
  cx: number
  cy: number
  r: number
  /** Optional focal point; defaults to (cx, cy) when omitted. */
  fx?: number
  fy?: number
  stops: GradientStop[]
}

export type GradientFill = LinearGradient | RadialGradient

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

/**
 * A junction in the planar subdivision: a lattice point where ≥3 region
 * boundaries meet. Its (x, y) is the single owner of the junction position —
 * every edge that ends here references it, so moving the vertex moves all
 * incident edges together.
 */
export interface Vertex {
  id: number
  x: number
  y: number
}

/**
 * One fitted boundary curve between exactly two regions, stored ONCE and
 * referenced (forward in one region, reversed in the other) so adjacent regions
 * are byte-coincident — no overlap, no hairline seam. `nodes` run start→end
 * (canonical direction). `startVertex`/`endVertex` index the doc's vertex table,
 * or are null for a pure closed-loop edge (e.g. a disc fully inside a field).
 */
export interface SharedEdge {
  id: number
  nodes: PathNode[]
  closed: boolean
  startVertex: number | null
  endVertex: number | null
}

/** A region's reference to a shared edge, traversed forward or reversed. */
export interface EdgeRef {
  edge: number
  reversed: boolean
}

/** The planar graph carried by a topological (planar-traced) EditableDoc. */
export interface Topology {
  vertices: Vertex[]
  edges: SharedEdge[]
}

/**
 * A stroked outline on a PathItem. Absent ⇒ fill only, which is every path the
 * tracer ever produces — the vectorizer models paint as filled regions, so this
 * is purely an authoring affordance of the SVG editor.
 */
export interface Stroke {
  /** #rrggbb. */
  color: string
  /** In viewBox units. */
  width: number
  cap: 'butt' | 'round' | 'square'
  join: 'miter' | 'round' | 'bevel'
  /** Dash pattern in viewBox units; omitted / empty ⇒ solid. */
  dash?: number[]
  /** 0–1; omitted means 1. */
  opacity?: number
}

/** A fillable, node-editable path (possibly compound — holes via subpaths). */
export interface PathItem {
  kind: 'path'
  id: string
  /** Editor-only display name for the layers list. Never serialized. */
  name?: string
  /**
   * Representative solid fill (#rrggbb). Always present, even when `gradient`
   * is set — it is the swatch color, the force-color / recolor base, and the
   * fallback for renderers that ignore gradients. Recoloring drops `gradient`.
   */
  fill: string
  /**
   * Optional gradient paint. When set, it takes precedence over `fill` for
   * rendering and export (emitted as an SVG paint server). Purely additive:
   * code paths that only read `fill` keep working unchanged.
   */
  gradient?: GradientFill
  /** 0–1; omitted means 1. */
  fillOpacity?: number
  /** Only 'evenodd' is ever serialized; nonzero is the SVG default. */
  fillRule: 'nonzero' | 'evenodd'
  /**
   * The region's boundary as ordered loops of shared-edge references (planar
   * model). When present, `subPaths` is a DERIVED render/hit cache rebuilt from
   * the doc's `topology` via materializeRegion; edits go through the edges so
   * shared boundaries stay coincident. Absent ⇒ legacy independent path (e.g.
   * an imported SVG) whose `subPaths` are edited directly.
   */
  loops?: EdgeRef[][]
  subPaths: SubPath[]
  /**
   * Optional stroke. Purely additive — the tracer never sets it, so traced
   * output is byte-identical whether or not this field exists.
   */
  stroke?: Stroke
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
  /** Editor-only display name for the layers list. Never serialized. */
  name?: string
  markup: string
  /** Composed `transform` attribute value inherited from ancestor groups. */
  transform?: string
  /** Inherited presentation attributes lost by flattening (fill, stroke…). */
  inherited?: Record<string, string>
  visible: boolean
}

/**
 * A named container of items — the layer folder of the SVG editor, serialized
 * as a plain `<g>`.
 *
 * DELIBERATELY CARRIES NO TRANSFORM. Every coordinate in this model is absolute
 * in viewBox units (see the file header), and that invariant is what lets any
 * consumer read `subPaths` without composing an ancestor chain — `parseSvg`
 * already bakes imported group transforms into their children for exactly this
 * reason. Grouping is therefore *structure only*: moving or scaling a group
 * rewrites its descendants' coordinates. That costs a walk per transform and
 * buys immunity to the entire class of bug where a coordinate means one thing
 * to the renderer and another to hit-testing.
 */
export interface GroupItem {
  kind: 'group'
  id: string
  /** Display name for the layers list; also emitted as the `<g>`'s data-name. */
  name?: string
  /** Paint order within the group: first = bottom. */
  children: DocItem[]
  /** Multiplies down onto descendants at render/serialize time. 0–1. */
  opacity?: number
  visible: boolean
  /** Editor-only: whether the layers list shows this group expanded. */
  expanded?: boolean
}

export type DocItem = PathItem | RawItem | GroupItem

export interface EditableDoc {
  /** [minX, minY, width, height] */
  viewBox: [number, number, number, number]
  /** Paint order: first = bottom. */
  items: DocItem[]
  /**
   * Shared-edge graph for planar-traced docs. Source of truth for any PathItem
   * carrying `loops`; their `subPaths` are materialized from it. Omitted for
   * legacy docs (independent paths only).
   */
  topology?: Topology
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
