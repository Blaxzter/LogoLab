// The Editor tab: intake until a document is open, then the full-height studio.
//
// The open document is kept here, not in the global store, because the editor
// can open things other than the logo (a dropped SVG, pasted markup, a blank
// artboard, an example). It persists across reloads in its own IndexedDB slot.
//
// Edits flow into the working logo automatically (debounced). Only changes do,
// never opening: see the `doc !== opened` guard in `onChange`. Empty artboards
// and markup identical to the current logo are skipped as well.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { EditableDoc } from '../../lib/path/types'
import { docStats, serializeDoc } from '../../lib/path/model'
import { useStore } from '../../store'
import { debounce } from '../../lib/persist/local'
import { claim, saveSlot, SLOTS, type StoredEditor } from '../../lib/persist/session'
import { EditorIntake } from '../editor/EditorIntake'
import { SvgEditorStudio } from '../editor/SvgEditorStudio'

/** The document the studio opens with. Edits flow out through `onChange`; keep
 *  this object stable while open, because the studio re-seeds its history (and
 *  drops undo) whenever `initialDoc` changes identity. */
type OpenDoc = { doc: EditableDoc; name: string }

/** Debounce for pushing edits into the logo, so a node drag is one apply rather
 *  than one per pointer move (each apply reserializes every path). */
const APPLY_MS = 500

/**
 * The open drawing, kept at module scope as well as in React state.
 *
 * This panel is a lazy route, so every tab switch unmounts it, and the stored
 * session can't stand in: the boot payload is claim-once and the first mount
 * already took it. Without this slot, leaving the tab and coming back would drop
 * the drawing and show the intake screen.
 */
let session: OpenDoc | null = null

export default function EditorPanel() {
  // Claimed during render so the studio mounts with the document in hand; the
  // ref makes it idempotent under StrictMode's double render.
  const restored = useRef<StoredEditor | null | undefined>(undefined)
  if (restored.current === undefined) {
    // The in-memory document wins: it includes the edits made since.
    restored.current = session
      ? ({ doc: session.doc, name: session.name } as StoredEditor)
      : claim('editor')
  }

  const [open, setOpenState] = useState<OpenDoc | null>(() =>
    restored.current ? { doc: restored.current.doc, name: restored.current.name } : null,
  )
  // Mirrored into the module slot so the next mount finds it.
  const setOpen = useCallback((next: OpenDoc | null) => {
    session = next
    setOpenState(next)
  }, [])
  const setProcessedSvg = useStore((s) => s.setProcessedSvg)

  const applyToLogo = useRef(
    debounce((doc: EditableDoc) => {
      // An empty artboard is a place to draw, not a logo.
      if (docStats(doc).paths === 0) return
      const svgText = serializeDoc(doc, 2)
      // Cheap secondary check only; it can't replace the `doc !== opened` guard
      // because the same drawing serializes differently after a parse round-trip.
      if (useStore.getState().logo.svgText === svgText) return
      setProcessedSvg(svgText, doc.viewBox[2], doc.viewBox[3])
    }, APPLY_MS),
  ).current

  // Apply any pending edit on unmount rather than letting it land later.
  useEffect(() => () => applyToLogo.flush(), [applyToLogo])

  const name = open?.name ?? 'drawing'
  // The document the studio was seeded with; `onChange` fires once with this
  // exact object before any edit.
  const opened = open?.doc ?? null
  const onChange = useCallback(
    (doc: EditableDoc) => {
      session = { doc, name }
      saveSlot(SLOTS.editor, { doc, name } satisfies Omit<StoredEditor, 'v'>, 900)
      // Don't treat the initial seed firing as an edit: a parseSvg → serializeDoc
      // round-trip yields different markup for the same drawing, so applying it
      // would reissue the working image, bump `assetKey` and drop the trace and
      // cleanup keyed to it. Don't swap this for a text comparison against
      // `logo.svgText` either; that doesn't survive the round-trip.
      if (doc !== opened) applyToLogo(doc)
    },
    [name, opened, applyToLogo],
  )

  // Closing drops the stored drawing so it doesn't reopen; the logo it produced
  // stays as the working image.
  const close = useCallback(() => {
    saveSlot(SLOTS.editor, null)
    setOpen(null)
  }, [])

  if (!open) {
    return <EditorIntake onOpen={(doc, openName) => setOpen({ doc, name: openName })} />
  }

  // Rendered as the route's direct child with no wrapper: the studio sizes itself
  // against <main>, and an intervening flex box makes its height negotiable,
  // which the canvas's ResizeObserver then fights.
  return (
    <SvgEditorStudio
      initialDoc={open.doc}
      fileName={open.name}
      onClose={close}
      onChange={onChange}
    />
  )
}
