// The in-flight pointer gesture on the stage, and the snap guides a drag shows.

import type { EditableDoc, Vec } from '../../../lib/path/types'
import type { Box, Grip } from '../../../lib/editor/transform'
import type { SnapCandidate, SnapTargets } from '../../../lib/editor/snapping'

export type Gesture =
  | { kind: 'marquee'; start: Vec; current: Vec; additive: boolean }
  | { kind: 'move'; start: Vec; base: EditableDoc; box: Box; targets: SnapTargets; moved: boolean }
  | { kind: 'grip'; grip: Grip; start: Vec; base: EditableDoc; box: Box; targets: SnapTargets }
  | { kind: 'rotate'; base: EditableDoc; center: Vec; startAngle: number }
  | {
      kind: 'nodes'
      start: Vec
      base: EditableDoc
      refs: { itemId: string; sub: number; idx: number }[]
      targets: SnapTargets
      moved: boolean
    }
  | {
      kind: 'handle'
      start: Vec
      base: EditableDoc
      itemId: string
      sub: number
      idx: number
      which: 'in' | 'out'
      mirror: boolean
    }
  | {
      kind: 'segment'
      start: Vec
      base: EditableDoc
      itemId: string
      sub: number
      seg: number
      t: number
      from: Vec
      whole: boolean
    }
  | { kind: 'draw'; start: Vec; current: Vec }
  | { kind: 'pen-handle'; start: Vec; base: EditableDoc; itemId: string; sub: number; idx: number }

export type Guides = { x: SnapCandidate | null; y: SnapCandidate | null }
