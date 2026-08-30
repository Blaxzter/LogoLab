// THE renderer for an EditableDoc — the single place that decides how a
// PathItem paints.
//
// It lives here, outside both studios, because there used to be two of these:
// one in the SVG editor and one in the vectorize canvas. They drifted, and the
// drift was invisible until it wasn't — teaching the importer to model strokes
// made stroked paths render correctly in the editor and vanish entirely in the
// vectorizer, because only one of the two copies knew what a stroke was.
//
// So: paint decisions go HERE and nowhere else. Interaction (hit layers,
// gestures, overlays) stays with each studio, because those genuinely differ —
// the vectorizer edits a planar shared-edge graph and drops region markers; the
// editor draws shapes and moves groups.

import { memo } from 'react'
import type { DocItem, GradientFill, PathItem, RawItem } from '../../lib/path/types'
import { subPathsToD } from '../../lib/path/model'
import { isGroup } from '../../lib/path/docTree'

/** Cached path data, keyed by the immutable subPaths array. */
const dCache = new WeakMap<object, string>()

export function pathD(item: PathItem): string {
  let d = dCache.get(item.subPaths)
  if (d === undefined) {
    d = subPathsToD(item.subPaths)
    dCache.set(item.subPaths, d)
  }
  return d
}

function escapeAttr(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
}

/**
 * Deterministic paint-server id for an item's gradient.
 *
 * `scope` namespaces it, because ids are DOCUMENT-global: a layer thumbnail
 * drawing the same item as the main canvas would otherwise emit a second
 * element with the same id, and the browser resolves `url(#…)` to whichever
 * came first — so one of the two would silently paint with the other's
 * gradient.
 */
export const gradIdOf = (itemId: string, scope = 'c') => `eg-${scope}-${itemId}`

/** SVG paint server for a gradient fill (absolute user-space coordinates). */
export function GradientDef({ id, gradient }: { id: string; gradient: GradientFill }) {
  const stops = gradient.stops.map((s, i) => (
    <stop key={i} offset={s.offset} stopColor={s.color} stopOpacity={s.opacity ?? 1} />
  ))
  if (gradient.type === 'linear') {
    return (
      <linearGradient
        id={id}
        gradientUnits="userSpaceOnUse"
        x1={gradient.x1}
        y1={gradient.y1}
        x2={gradient.x2}
        y2={gradient.y2}
      >
        {stops}
      </linearGradient>
    )
  }
  return (
    <radialGradient
      id={id}
      gradientUnits="userSpaceOnUse"
      cx={gradient.cx}
      cy={gradient.cy}
      r={gradient.r}
      fx={gradient.fx}
      fy={gradient.fy}
    >
      {stops}
    </radialGradient>
  )
}

/**
 * One filled / stroked path. `interactive` makes it a pointer target — a
 * stroke-only path has no interior, so its painted area IS the stroke and
 * `visiblePainted` would leave it unclickable.
 */
export const PathView = memo(function PathView({
  item,
  interactive = false,
  scope,
}: {
  item: PathItem
  interactive?: boolean
  /** Namespace for this render's gradient ids — see {@link gradIdOf}. */
  scope?: string
}) {
  const gid = item.gradient ? gradIdOf(item.id, scope) : null
  const s = item.stroke
  const stroked = s !== undefined && s.width > 0
  return (
    <>
      {item.gradient && (
        <defs>
          <GradientDef id={gid!} gradient={item.gradient} />
        </defs>
      )}
      <path
        data-id={item.id}
        d={pathD(item)}
        fill={gid ? `url(#${gid})` : item.fill}
        fillOpacity={item.fillOpacity}
        fillRule={item.fillRule}
        stroke={stroked ? s.color : undefined}
        strokeWidth={stroked ? s.width : undefined}
        strokeLinecap={s?.cap}
        strokeLinejoin={s?.join}
        strokeDasharray={s?.dash && s.dash.length > 0 ? s.dash.join(' ') : undefined}
        strokeOpacity={s?.opacity}
        style={
          interactive
            ? {
                pointerEvents: stroked ? 'visibleStroke' : 'visiblePainted',
                cursor: 'move',
              }
            : undefined
        }
      />
    </>
  )
})

/**
 * Invisible wide-stroke copy so a thin outline stays grabbable. Separate from
 * PathView because it belongs to the interaction layer, not the paint layer —
 * but it needs the same `d`, so it lives next to the cache.
 */
export const HitPath = memo(function HitPath({
  item,
  width,
}: {
  item: PathItem
  width: number
}) {
  return (
    <path
      data-id={item.id}
      d={pathD(item)}
      fill="none"
      stroke="transparent"
      strokeWidth={width}
      style={{ pointerEvents: 'stroke', cursor: 'move' }}
    />
  )
})

/** Verbatim markup re-wrapped in the ancestor context it was lifted out of. */
export const RawView = memo(function RawView({ item }: { item: RawItem }) {
  const inherited = item.inherited ?? {}
  const keys = Object.keys(inherited)
  let html = item.markup
  if (item.transform || keys.length > 0) {
    let open = '<g'
    if (item.transform) open += ` transform="${escapeAttr(item.transform)}"`
    for (const key of keys) open += ` ${key}="${escapeAttr(inherited[key])}"`
    html = `${open}>${item.markup}</g>`
  }
  // Raw markup is never a pointer target: it is geometry we deliberately don't
  // model, so we can't say anything useful about where it was clicked.
  return <g style={{ pointerEvents: 'none' }} dangerouslySetInnerHTML={{ __html: html }} />
})

/** Draw a list of items in paint order, recursing into groups. */
export const ItemsView = memo(function ItemsView({
  items,
  interactive = false,
  scope,
}: {
  items: readonly DocItem[]
  interactive?: boolean
  scope?: string
}) {
  return (
    <>
      {items.map((item) => {
        if (!item.visible) return null
        if (isGroup(item)) {
          return (
            <g key={item.id} opacity={item.opacity ?? undefined} data-id={item.id}>
              <ItemsView items={item.children} interactive={interactive} scope={scope} />
            </g>
          )
        }
        return item.kind === 'path' ? (
          <PathView key={item.id} item={item} interactive={interactive} scope={scope} />
        ) : (
          <RawView key={item.id} item={item} />
        )
      })}
    </>
  )
})

/** Every visible path in the tree, in paint order — for the hit / overlay layers. */
export function visiblePaths(items: readonly DocItem[]): PathItem[] {
  const out: PathItem[] = []
  const walk = (list: readonly DocItem[]) => {
    for (const it of list) {
      if (!it.visible) continue
      if (isGroup(it)) walk(it.children)
      else if (it.kind === 'path') out.push(it)
    }
  }
  walk(items)
  return out
}
