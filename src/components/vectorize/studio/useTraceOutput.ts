// What the studio shows and exports: the force-coloured doc, its SVG, stats and palette.

import { useMemo } from 'react'
import { hexToRgb, normalizeHex } from '../../../lib/colorUtils'
import { docStats, serializeDoc } from '../../../lib/path/model'
import type { EditableDoc } from '../../../lib/path/types'

export function useTraceOutput({
  doc,
  forceColorOn,
  forceColor,
  precision,
}: {
  doc: EditableDoc | null
  forceColorOn: boolean
  forceColor: string
  precision: number
}) {
  const derivedDoc = useMemo(() => {
    if (!doc) return null
    if (!forceColorOn) return doc
    return {
      ...doc,
      // A stroke-only path (a centreline trace) keeps `fill: 'none'` and takes the colour
      // on its stroke; anything else takes it on its fill.
      items: doc.items.map((it) =>
        it.kind !== 'path'
          ? it
          : it.fill === 'none' && it.stroke
            ? { ...it, stroke: { ...it.stroke, color: forceColor } }
            : {
                ...it,
                fill: forceColor,
                gradient: undefined,
                ...(it.stroke ? { stroke: { ...it.stroke, color: forceColor } } : {}),
              },
      ),
    }
  }, [doc, forceColorOn, forceColor])

  // Auto-extracted flat palette: the distinct solid fills of the base doc (not the
  // force-coloured one) in paint order, with alpha from fill-opacity. Gradient
  // items are skipped. Seeds the palette editor.
  const autoPalette = useMemo(() => {
    if (!doc) return []
    const seen = new Set<string>()
    const out: { r: number; g: number; b: number; a?: number }[] = []
    for (const it of doc.items) {
      if (it.kind !== 'path' || it.gradient) continue
      const hex = normalizeHex(it.fill === 'none' && it.stroke ? it.stroke.color : it.fill)
      if (!hex) continue
      const a = it.fillOpacity !== undefined && it.fillOpacity < 1 ? Math.round(it.fillOpacity * 255) : 255
      const key = `${hex}-${a}`
      if (seen.has(key)) continue
      seen.add(key)
      const rgb = hexToRgb(hex)
      if (rgb) out.push(a < 255 ? { ...rgb, a } : rgb)
    }
    return out
  }, [doc])

  const svgText = useMemo(() => (derivedDoc ? serializeDoc(derivedDoc, precision) : null), [derivedDoc, precision])
  const svgBytes = useMemo(() => (svgText ? new TextEncoder().encode(svgText).length : 0), [svgText])
  const stats = useMemo(() => (derivedDoc ? docStats(derivedDoc) : null), [derivedDoc])

  return { derivedDoc, autoPalette, svgText, svgBytes, stats }
}
