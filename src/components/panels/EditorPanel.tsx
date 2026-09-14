// The Editor tab: intake until a document is open, then the full-height studio.
//
// The open document lives here rather than in the global store because the two
// are not the same thing — the editor opens on a dropped SVG, pasted markup, a
// blank artboard or an example just as readily as on your logo. It survives a
// RELOAD through its own IndexedDB slot: a drawing is the most expensive thing
// in the app to lose and the least reproducible, since nothing else in the
// session can re-derive it.
//
// WHAT IT DRAWS IS THE LOGO. There used to be a "Use as logo" button and no
// other connection, which meant you could draw for ten minutes, switch to
// Preview, and find it empty with nothing on screen explaining why. So the
// document flows into the working logo by itself, debounced, and the button is
// gone.
//
// The rule is CHANGES, not opening. Opening is not an edit, and treating it as
// one was actively destructive: round-tripping your logo through parse →
// serialize produces different markup for the same drawing, so merely visiting
// this tab reissued the working image and invalidated the trace and the cleanup
// buffer keyed to it. It also means browsing an example or a dropped SVG leaves
// your logo alone until you actually touch something — which is the whole of the
// "could this silently replace my logo?" worry, gone without a mode to explain.
//
// Two more guards: an EMPTY artboard is a place to draw rather than a logo, and
// markup identical to what is already the working image is skipped.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { EditableDoc } from '../../lib/path/types'
import { docStats, serializeDoc } from '../../lib/path/model'
import { useStore } from '../../store'
import { debounce } from '../../lib/persist/local'
import { claim, saveSlot, SLOTS, type StoredEditor } from '../../lib/persist/session'
import { EditorIntake } from '../editor/EditorIntake'
import { SvgEditorStudio } from '../editor/SvgEditorStudio'

/** The document the studio OPENS with. Edits flow out through `onChange`, not by
 *  rewriting this — the studio re-seeds its history (and drops undo) whenever
 *  `initialDoc` changes identity, so it has to stay the same object while open. */
type OpenDoc = { doc: EditableDoc; name: string }

/**
 * Long enough that a node drag is one apply rather than sixty. Serializing
 * rebuilds the `d` of every path in the drawing and the working image is a fresh
 * blob each time, so this runs on the pause, not on the gesture.
 */
const APPLY_MS = 500

/**
 * The open drawing, for as long as the tab is alive.
 *
 * This panel is a lazy ROUTE: switching to Preview unmounts it and switching
 * back mounts a new one, so React state alone loses the document on every tab
 * click — and the stored session is no help, because the boot payload is
 * claim-once and was already taken by the first mount. The result was an editor
 * that dropped your drawing and showed the intake screen every time you looked
 * at another tab.
 *
 * Module scope rather than a store because it is exactly as long-lived as this
 * module: cleared on close, replaced on open, gone when the tab is.
 */
let session: OpenDoc | null = null

export default function EditorPanel() {
  // Claimed in the render body, not an effect: the studio must mount with the
  // document already in hand, and claiming is idempotent here — StrictMode's
  // second pass reuses this ref rather than taking a second, empty read.
  const restored = useRef<StoredEditor | null | undefined>(undefined)
  if (restored.current === undefined) {
    // The live document wins: it is this one with the edits made since.
    restored.current = session
      ? ({ doc: session.doc, name: session.name } as StoredEditor)
      : claim('editor')
  }

  const [open, setOpenState] = useState<OpenDoc | null>(() =>
    restored.current ? { doc: restored.current.doc, name: restored.current.name } : null,
  )
  // Every change to what's open is mirrored, so the next mount finds it.
  const setOpen = useCallback((next: OpenDoc | null) => {
    session = next
    setOpenState(next)
  }, [])
  const setProcessedSvg = useStore((s) => s.setProcessedSvg)

  const applyToLogo = useRef(
    debounce((doc: EditableDoc) => {
      // An artboard with nothing on it is a place to draw, not a logo.
      if (docStats(doc).paths === 0) return
      const svgText = serializeDoc(doc, 2)
      // Byte-identical to the working image: nothing to do. A weaker guard than
      // the opened-document check below — the same drawing serializes differently
      // after a parse round-trip — but it costs nothing and catches the rest.
      if (useStore.getState().logo.svgText === svgText) return
      setProcessedSvg(svgText, doc.viewBox[2], doc.viewBox[3])
    }, APPLY_MS),
  ).current

  // Nothing is in flight after the tab goes away, and a pending apply that lands
  // against an unmounted panel would be a surprise edit to the logo.
  useEffect(() => () => applyToLogo.flush(), [applyToLogo])

  const name = open?.name ?? 'drawing'
  // The document the studio was seeded with. `onChange` fires once with this
  // exact object before any edit; that firing is an OPEN, not a change.
  const opened = open?.doc ?? null
  const onChange = useCallback(
    (doc: EditableDoc) => {
      // Track the edits, not just the document it opened with — coming back to
      // the tab should land on the drawing as you left it.
      session = { doc, name }
      saveSlot(SLOTS.editor, { doc, name } satisfies Omit<StoredEditor, 'v'>, 900)
      if (doc !== opened) applyToLogo(doc)
    },
    [name, opened, applyToLogo],
  )

  // Closing is an explicit "I'm done with this drawing", so it drops the slot —
  // keeping it would re-open a document the user just dismissed. The logo it
  // produced stays: it is the working image now, not the editor's to take back.
  const close = useCallback(() => {
    saveSlot(SLOTS.editor, null)
    setOpen(null)
  }, [])

  if (!open) {
    return <EditorIntake onOpen={(doc, openName) => setOpen({ doc, name: openName })} />
  }

  // Rendered as the route's DIRECT child, with no wrapper — the studio sizes
  // itself against <main> (h-full + shrink-0), and an intervening flex-1 box
  // makes its height negotiable, which the canvas's ResizeObserver then fights.
  return (
    <SvgEditorStudio
      initialDoc={open.doc}
      fileName={open.name}
      onClose={close}
      onChange={onChange}
    />
  )
}
