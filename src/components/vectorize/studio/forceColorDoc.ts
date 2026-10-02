// Force colour: every shape repainted in one colour. The studio shows, scores and
// exports this document, and "Find best settings" scores a candidate that brings a
// recolour through the same mapping, so the two numbers describe the same paint.

import type { EditableDoc } from '../../../lib/path/types.ts'
import { isPaper } from '../../../lib/path/paper.ts'

export function forceColorDoc(doc: EditableDoc, color: string): EditableDoc {
  return {
    ...doc,
    // A stroke-only path (a centreline trace) keeps `fill: 'none'` and takes the
    // colour on its stroke; anything else takes it on its fill. The paper is the ground,
    // not a shape: painted in the ink it would be a solid square (path/paper.ts).
    items: doc.items.map((it) =>
      it.kind !== 'path' || isPaper(it)
        ? it
        : it.fill === 'none' && it.stroke
          ? { ...it, stroke: { ...it.stroke, color } }
          : {
              ...it,
              fill: color,
              gradient: undefined,
              ...(it.stroke ? { stroke: { ...it.stroke, color } } : {}),
            },
    ),
  }
}
