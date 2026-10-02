import type { Variants } from 'motion/react'

/** One SVG node of a ported icon. A `key` names its variants; no key = static. */
export interface MotionIconElement {
  tag: 'path' | 'line' | 'rect' | 'circle' | 'ellipse' | 'polyline' | 'polygon' | 'g'
  /** SVG attributes, plus the odd Motion prop (`transition`, `custom`). */
  attrs: Record<string, unknown>
  key?: string
  style?: Record<string, string>
  children?: MotionIconElement[]
}

/** An animated icon: its element tree and the Motion variants per key. */
export interface MotionIconData {
  name: string
  elements: MotionIconElement[]
  variants: Record<string, Variants>
}
