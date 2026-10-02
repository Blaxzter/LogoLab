// The open text's chrome: the selection highlight, the blinking caret, the
// curve a text runs along, and the hidden textarea that does the typing.
//
// The typing is a real <textarea> rather than key handlers: composition (IME,
// dead keys), the clipboard, word-wise deletes and the platform's own
// shortcuts then all just work, and the edit is read back as one replaced
// span (`useTextEditing.input`). It sits at the caret so an IME's candidate
// window opens next to the text, and is invisible.

import { useEffect, useLayoutEffect, useRef } from 'react'
import type { EditableDoc, TextData } from '../../../lib/path/types'
import { findItem, isText } from '../../../lib/path/docTree'
import { transformSubPaths } from '../../../lib/path/geometry'
import { subPathsToD } from '../../../lib/path/model'
import { plainText } from '../../../lib/text/edit'
import type { TextEditing } from '../studio/useTextEditing'
import { ACCENT } from './stageConstants'

export function TextEditOverlay({ text, doc, r }: { text: TextEditing; doc: EditableDoc; r: (px: number) => number }) {
  const { edit, layout } = text
  if (!edit || !layout) return null
  const open = findItem(doc.items, edit.id)
  const data: TextData | null = open && isText(open) ? open.text : null
  const a = Math.min(edit.anchor, edit.focus)
  const b = Math.max(edit.anchor, edit.focus)
  const quads: string[] = []
  for (let i = a; i < b; i++) {
    const c0 = layout.carets[i]
    const c1 = layout.carets[i + 1]
    if (!c0 || !c1 || c0.line !== c1.line) continue
    quads.push(
      `${c0.top.x},${c0.top.y} ${c1.top.x},${c1.top.y} ${c1.bottom.x},${c1.bottom.y} ${c0.bottom.x},${c0.bottom.y}`,
    )
  }
  const caret = a === b ? layout.carets[a] : null
  return (
    <g style={{ pointerEvents: 'none' }}>
      {data?.onPath && (
        <path
          d={subPathsToD(transformSubPaths([data.onPath.path], data.matrix))}
          fill="none"
          stroke={ACCENT}
          strokeWidth={r(1)}
          strokeDasharray={`${r(4)} ${r(3)}`}
          opacity={0.6}
        />
      )}
      {quads.map((q) => (
        <polygon key={q} points={q} fill={ACCENT} fillOpacity={0.25} />
      ))}
      {caret && (
        <line
          x1={caret.top.x}
          y1={caret.top.y}
          x2={caret.bottom.x}
          y2={caret.bottom.y}
          stroke={ACCENT}
          strokeWidth={r(1.5)}
        >
          <animate attributeName="opacity" values="1;0" dur="1.1s" calcMode="discrete" repeatCount="indefinite" />
        </line>
      )}
    </g>
  )
}

/**
 * The hidden textarea. Positioned in the artboard box by percentage, so it
 * needs no screen maths: `frame` is the document rect the box shows.
 */
export function TextInput({
  text,
  doc,
  frame,
  undo,
  redo,
  onEscape,
}: {
  text: TextEditing
  doc: EditableDoc
  frame: [number, number, number, number]
  undo: () => void
  redo: () => void
  /** Esc leaves typing for the Move tool, the text still selected. */
  onEscape: () => void
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null)
  const { edit, layout } = text
  const open = edit ? findItem(doc.items, edit.id) : null
  const value = open && isText(open) ? plainText(open.text) : ''

  // Keep the textarea's own value and selection in step with the document
  // (undo, a style change, a click on the canvas) and keep focus in it.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !edit) return
    if (el.value !== value) el.value = value
    const a = Math.min(edit.anchor, edit.focus)
    const b = Math.max(edit.anchor, edit.focus)
    if (el.selectionStart !== a || el.selectionEnd !== b) {
      el.setSelectionRange(a, b, edit.focus < edit.anchor ? 'backward' : 'forward')
    }
  })
  useEffect(() => {
    if (!edit) return
    // A frame later: the click that opened the text is still in flight, and the
    // browser's own mousedown handling would move focus off the textarea again.
    const raf = requestAnimationFrame(() => {
      // Not while another control is being used (a font picked in the rail).
      const active = document.activeElement
      if (active && active !== document.body && active !== ref.current && active.closest('aside')) return
      ref.current?.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(raf)
  }, [edit])

  if (!edit) return null
  const caret = layout?.carets[edit.focus]
  const [fx, fy, fw, fh] = frame
  const left = caret ? ((caret.bottom.x - fx) / fw) * 100 : 0
  const top = caret ? ((caret.bottom.y - fy) / fh) * 100 : 0

  const read = (el: HTMLTextAreaElement) => {
    const back = el.selectionDirection === 'backward'
    return back ? ([el.selectionEnd, el.selectionStart] as const) : ([el.selectionStart, el.selectionEnd] as const)
  }

  return (
    <textarea
      ref={ref}
      aria-label="Text"
      defaultValue={value}
      wrap="off"
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      onInput={(e) => {
        const el = e.currentTarget
        const [anchor, focus] = read(el)
        text.input(el.value, anchor, focus)
      }}
      onSelect={(e) => {
        const [anchor, focus] = read(e.currentTarget)
        if (anchor !== edit.anchor || focus !== edit.focus) text.setRange(anchor, focus)
      }}
      onKeyDown={(e) => {
        const mod = e.ctrlKey || e.metaKey
        const k = e.key.toLowerCase()
        if (e.key === 'Escape') {
          // Leave typing; the text stays selected for the Move tool.
          e.preventDefault()
          text.end()
          onEscape()
        } else if (mod && k === 'z') {
          // The document's history, not the textarea's: they would disagree.
          e.preventDefault()
          if (e.shiftKey) redo()
          else undo()
        } else if (mod && k === 'y') {
          e.preventDefault()
          redo()
        } else if (mod && k === 'b') {
          e.preventDefault()
          const w = text.shownStyle((open as { text: TextData }).text).weight ?? 400
          text.restyle({ weight: w >= 600 ? 400 : 700 })
        } else if (mod && k === 'i') {
          e.preventDefault()
          const it = text.shownStyle((open as { text: TextData }).text).italic ?? false
          text.restyle({ italic: !it })
        }
      }}
      className="pointer-events-none absolute resize-none overflow-hidden border-0 bg-transparent p-0 opacity-0 outline-none"
      style={{ left: `${left}%`, top: `${top}%`, width: 2, height: '1.2em', fontSize: 16, whiteSpace: 'pre' }}
    />
  )
}
