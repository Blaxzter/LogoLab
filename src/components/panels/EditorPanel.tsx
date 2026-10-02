// The Editor tab: intake until a document is open, then the full-height studio.
//
// The tab shows the app's working logo — whatever Cleanup, Vectorize or an
// upload last put there — whenever that is an SVG. It can also open things that
// are not the logo yet (a dropped SVG, pasted markup, a blank artboard, an
// example); those become the logo once edited. The open document persists across
// reloads in its own IndexedDB slot.
//
// Edits flow into the working logo automatically (debounced). Only changes do,
// never opening: see the `doc !== opened` guard in `onChange`. Empty artboards
// and markup identical to the current logo are skipped as well.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { EditableDoc } from '../../lib/path/types'
import { docStats, parseSvg, serializeDoc } from '../../lib/path/model'
import { useStore } from '../../state/store'
import { debounce } from '../../lib/persist/local'
import { claim, saveSlot, SLOTS, type StoredEditor } from '../../lib/persist/session'
import { EditorIntake } from '../editor/EditorIntake'
import { SvgEditorStudio } from '../editor/SvgEditorStudio'
import { adoptIds } from '../editor/editorDoc'

/** The document the studio opens with. Edits flow out through `onChange`; keep
 *  this object stable while open, because the studio re-seeds its history (and
 *  drops undo) whenever `initialDoc` changes identity. */
type OpenDoc = { doc: EditableDoc; name: string }

/**
 * What the tab is showing, and the working logo (`assetKey`) it last saw. When
 * the logo's key has moved on since, another tab changed it and the editor
 * follows; while it hasn't, the editor keeps what it has open — including a
 * dropped file that isn't the logo, or the intake after Close.
 */
type EditorSession = { open: OpenDoc | null; seenKey: string }

/** Debounce for pushing edits into the logo, so a node drag is one apply rather
 *  than one per pointer move (each apply reserializes every path). */
const APPLY_MS = 500

/**
 * The tab's state, kept at module scope as well as in React state.
 *
 * This panel is a lazy route, so every tab switch unmounts it, and the stored
 * session can't stand in: the boot payload is claim-once and the first mount
 * already took it. Without this slot, leaving the tab and coming back would drop
 * the drawing and show the intake screen.
 */
let session: EditorSession | null = null

/** Bring a session up to the current working logo: if another tab changed it, open that. */
function follow(prev: EditorSession | null): EditorSession {
  const { logo, assetKey } = useStore.getState()
  if (prev && prev.seenKey === assetKey) return prev
  const name = logo.fileName?.replace(/\.[^.]+$/, '') ?? 'logo'
  const doc = logo.isSvg && logo.svgText ? parseSvg(logo.svgText, { preserveGroups: true }) : null
  if (doc) adoptIds(doc)
  // A bitmap logo (or none) leaves nothing to edit: back to the intake, which says why.
  return { open: doc ? { doc, name } : null, seenKey: assetKey }
}

function initialSession(): EditorSession {
  if (session) return follow(session)
  const stored = claim('editor')
  const { assetKey } = useStore.getState()
  // A record from before the tabs shared the logo has no key: take it as current.
  if (stored) return follow({ open: { doc: stored.doc, name: stored.name }, seenKey: stored.seenKey ?? assetKey })
  return follow(null)
}

export default function EditorPanel() {
  // Resolved during render so the studio mounts with the document in hand; the
  // ref makes it idempotent under StrictMode's double render.
  const initial = useRef<EditorSession | null>(null)
  if (!initial.current) initial.current = initialSession()

  const [state, setStateRaw] = useState<EditorSession>(initial.current)
  // Mirrored into the module slot (and storage) so the next mount finds it.
  const setState = useCallback((next: EditorSession) => {
    session = next
    setStateRaw(next)
    saveSlot(
      SLOTS.editor,
      next.open ? ({ ...next.open, seenKey: next.seenKey } satisfies Omit<StoredEditor, 'v'>) : null,
      next.open ? 900 : 0,
    )
  }, [])
  useEffect(() => {
    if (initial.current !== session) setState(initial.current!)
  }, [setState])

  // The working logo can change while this tab is open too (Clear in the header).
  const assetKey = useStore((s) => s.assetKey)
  useEffect(() => {
    const cur = session ?? initial.current!
    const next = follow(cur)
    if (next !== cur) setState(next)
  }, [assetKey, setState])

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
      // Our own write: the key moved, but the editor already shows this drawing.
      if (session) session = { ...session, seenKey: useStore.getState().assetKey }
    }, APPLY_MS),
  ).current

  // Apply any pending edit on unmount rather than letting it land later.
  useEffect(() => () => applyToLogo.flush(), [applyToLogo])

  const open = state.open
  const name = open?.name ?? 'drawing'
  // The document the studio was seeded with; `onChange` fires once with this
  // exact object before any edit.
  const opened = open?.doc ?? null
  const onChange = useCallback(
    (doc: EditableDoc) => {
      // Not setState: re-seeding the studio with its own output would drop undo.
      session = { open: { doc, name }, seenKey: session?.seenKey ?? useStore.getState().assetKey }
      saveSlot(SLOTS.editor, { doc, name, seenKey: session.seenKey } satisfies Omit<StoredEditor, 'v'>, 900)
      // Don't treat the initial seed firing as an edit: a parseSvg → serializeDoc
      // round-trip yields different markup for the same drawing, so applying it
      // would reissue the working image, bump `assetKey` and drop the trace and
      // cleanup keyed to it. Don't swap this for a text comparison against
      // `logo.svgText` either; that doesn't survive the round-trip.
      if (doc !== opened) applyToLogo(doc)
    },
    [name, opened, applyToLogo],
  )

  // Closing shows the intake until the logo changes again; the logo the drawing
  // produced stays as the working image.
  const close = useCallback(() => {
    applyToLogo.flush()
    setState({ open: null, seenKey: useStore.getState().assetKey })
  }, [setState, applyToLogo])

  if (!open) {
    return (
      <EditorIntake
        onOpen={(doc, openName) => setState({ open: { doc, name: openName }, seenKey: useStore.getState().assetKey })}
      />
    )
  }

  // Rendered as the route's direct child with no wrapper: the studio sizes itself
  // against <main>, and an intervening flex box makes its height negotiable,
  // which the canvas's ResizeObserver then fights. Keyed on the document so a
  // logo changed elsewhere re-seeds the studio.
  return (
    <SvgEditorStudio
      key={keyOf(open.doc)}
      initialDoc={open.doc}
      fileName={open.name}
      onClose={close}
      onChange={onChange}
    />
  )
}

/** A stable per-document key (the studio already re-seeds on a new `initialDoc`; this resets its local UI too). */
const docKeys = new WeakMap<EditableDoc, number>()
let nextDocKey = 0
function keyOf(doc: EditableDoc): number {
  let k = docKeys.get(doc)
  if (k === undefined) docKeys.set(doc, (k = ++nextDocKey))
  return k
}
