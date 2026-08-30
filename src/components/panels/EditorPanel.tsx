// The Editor tab: intake until a document is open, then the full-height studio.
//
// The open document lives here rather than in the global store because it is
// genuinely tab-local — it is not "the app's logo", and a drawing you started
// should survive tab switches without ever silently becoming the working logo.

import { useState } from 'react'
import type { EditableDoc } from '../../lib/path/types'
import { useStore } from '../../store'
import { EditorIntake } from '../editor/EditorIntake'
import { SvgEditorStudio } from '../editor/SvgEditorStudio'

export default function EditorPanel() {
  const [open, setOpen] = useState<{ doc: EditableDoc; name: string } | null>(null)
  const setProcessedSvg = useStore((s) => s.setProcessedSvg)

  if (!open) {
    return <EditorIntake onOpen={(doc, name) => setOpen({ doc, name })} />
  }

  // Rendered as the route's DIRECT child, with no wrapper — the studio sizes
  // itself against <main> (h-full + shrink-0), and an intervening flex-1 box
  // makes its height negotiable, which the canvas's ResizeObserver then fights.
  return (
    <SvgEditorStudio
      initialDoc={open.doc}
      fileName={open.name}
      onClose={() => setOpen(null)}
      onApply={(svgText, w, h) => setProcessedSvg(svgText, w, h)}
    />
  )
}
