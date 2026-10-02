// HarfBuzz behind the `ShapingFace` interface layout.ts lays out with.
//
// HarfBuzz rather than a JavaScript font parser because the features are the
// point: GSUB/GPOS shaping (ligatures, small caps, stylistic sets, figure
// styles, contextual alternates), GPOS kerning and variable-font axes are all
// real here, where the JS parsers implement a subset. It is ~430 KB of WASM, so
// this module is reached only through a dynamic import (`fonts.ts`).

import * as hb from 'harfbuzzjs'
import type { OutlineCmd, ShapedGlyph, ShapingFace } from './layout.ts'
import { parseGlyphPath } from './layout.ts'

export interface FontAxis {
  tag: string
  min: number
  default: number
  max: number
}

/** A parsed font: the shaping face plus what the inspector offers for it. */
export interface LoadedFace extends ShapingFace {
  family: string
  subfamily: string
  axes: FontAxis[]
  /** OpenType feature tags the font has (GSUB + GPOS), deduplicated. */
  features: string[]
}

const varKey = (v: Record<string, number>) =>
  Object.keys(v)
    .sort()
    .map((k) => `${k}=${v[k]}`)
    .join(',')

export function faceFromBytes(bytes: ArrayBuffer): LoadedFace {
  const face = new hb.Face(new hb.Blob(bytes))
  if (face.upem === 0) throw new Error('Not a font HarfBuzz can read.')
  const font = new hb.Font(face)
  const ext = font.hExtents()
  const axes = Object.values(face.getAxisInfos()).map((a) => ({
    tag: a.tag,
    min: a.min,
    default: a.default,
    max: a.max,
  }))
  const axisTags = new Set(axes.map((a) => a.tag))
  const features = [...new Set([...face.getTableFeatureTags('GSUB'), ...face.getTableFeatureTags('GPOS')])].sort()

  // Variations are font state in HarfBuzz; set them only when they change.
  let current = ''
  const setVariations = (v: Record<string, number>) => {
    const own: Record<string, number> = {}
    for (const [k, val] of Object.entries(v)) if (axisTags.has(k)) own[k] = val
    const key = varKey(own)
    if (key === current) return key
    font.setVariations(Object.entries(own).map(([tag, value]) => new hb.Variation(tag, value)))
    current = key
    return key
  }

  const outlines = new Map<string, OutlineCmd[]>()

  return {
    family: face.getName(16, 'en') || face.getName(1, 'en') || 'Untitled font',
    subfamily: face.getName(17, 'en') || face.getName(2, 'en') || '',
    axes,
    features,
    upem: face.upem,
    ascender: ext.ascender,
    descender: ext.descender,
    shape(text, feats, variations): ShapedGlyph[] {
      setVariations(variations)
      const buf = new hb.Buffer()
      buf.addText(text)
      buf.guessSegmentProperties()
      hb.shape(
        font,
        buf,
        Object.entries(feats).map(([tag, value]) => new hb.Feature(tag, value)),
      )
      return buf.getGlyphInfosAndPositions().map((g) => ({
        gid: g.codepoint,
        cluster: g.cluster,
        ax: g.xAdvance ?? 0,
        dx: g.xOffset ?? 0,
        dy: g.yOffset ?? 0,
      }))
    },
    outline(gid, variations) {
      const key = `${setVariations(variations)}|${gid}`
      let cmds = outlines.get(key)
      if (!cmds) {
        cmds = parseGlyphPath(font.glyphToPath(gid))
        outlines.set(key, cmds)
      }
      return cmds
    },
  }
}
