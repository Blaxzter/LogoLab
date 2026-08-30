// One icon per tool, shared by the toolbar and the shape flyout so a tool looks
// the same wherever it shows up.

import {
  Circle as CircleIcon,
  Hand,
  Hexagon,
  MousePointer2,
  PenTool,
  Slash,
  Spline,
  Square as SquareIcon,
  Star,
} from 'lucide-react'
import type { EditorTool } from './tools'

export const TOOL_ICON: Record<EditorTool, React.ReactNode> = {
  select: <MousePointer2 size={15} />,
  node: <Spline size={15} />,
  pen: <PenTool size={15} />,
  rect: <SquareIcon size={15} />,
  ellipse: <CircleIcon size={15} />,
  line: <Slash size={15} />,
  polygon: <Hexagon size={15} />,
  star: <Star size={15} />,
  pan: <Hand size={15} />,
}
