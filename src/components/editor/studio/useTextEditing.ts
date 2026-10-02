// Live text editing: which text is open, its selection, and every change to a
// text's words or styles.
//
// Every change goes through `apply`, which makes sure the faces the NEW text
// needs are loaded before laying it out — a font picked from the list, or the
// italic of a family, is fetched first and the text is laid out once, in the
// right face, rather than drawn in a fallback and swapped. Typing is committed
// as a merged history entry per text, so a burst of keystrokes is one undo.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { EditableDoc, GroupItem, TextData, TextStyle, Vec } from '../../../lib/path/types'
import { findItem, isText, removeItems, replaceItem } from '../../../lib/path/docTree'
import {
  facesUsed,
  layoutGroup,
  makeTextGroup,
  newTextData,
  plainText,
  rangeStyle,
  replaceText,
  styleRange,
} from '../../../lib/text/edit'
import { fontsVersion, loadFontsFor, lookupFace, subscribeFonts } from '../../../lib/text/fonts'
import { pathFraction, type TextLayout } from '../../../lib/text/layout'
import { newId } from '../editorDoc'

export interface TextEditState {
  id: string
  /** Where a drag-select started; `focus` is where it is now. Equal = a caret. */
  anchor: number
  focus: number
}

export interface TextEditing {
  edit: TextEditState | null
  /** The open text's layout (carets for the overlay), or null. */
  layout: TextLayout | null
  /** Style picked with a bare caret: applies to what is typed next. */
  typing: Partial<TextStyle> | null
  begin: (id: string, caret?: number | 'end' | 'all') => void
  /** A new text at `at`, or along `path` when given (the path is consumed, as in Affinity). */
  create: (at: Vec, pathId?: string | null) => void
  end: () => void
  setRange: (anchor: number, focus: number) => void
  /** The hidden textarea changed: new value and selection. */
  input: (value: string, selStart: number, selEnd: number) => void
  /** Style the selection (open text), the typing style (bare caret) or the selected texts. */
  restyle: (patch: Partial<TextStyle>, live?: boolean) => void
  /** Paragraph-level settings: align, line height, kerning, the path. */
  setProps: (patch: Partial<Pick<TextData, 'align' | 'lineHeight' | 'kerning' | 'onPath'>>, live?: boolean) => void
  /** What the inspector shows: the selection's style (mixed props absent). */
  shownStyle: (data: TextData) => Partial<TextStyle>
}

export function useTextEditing({
  docRef,
  selection,
  commit,
  commitLive,
  setSelection,
}: {
  docRef: React.RefObject<EditableDoc>
  selection: ReadonlySet<string>
  commit: (doc: EditableDoc) => void
  commitLive: (doc: EditableDoc, control: string) => void
  setSelection: (ids: ReadonlySet<string>) => void
}): TextEditing {
  // A commit only reaches `docRef` on the next render; two text operations in
  // one tick (end the empty text, then create the next) must see each other.
  const commitNow = useCallback(
    (doc: EditableDoc, live: string | null = null) => {
      if (live) commitLive(doc, live)
      else commit(doc)
      docRef.current = doc
    },
    [docRef, commit, commitLive],
  )
  const [edit, setEdit] = useState<TextEditState | null>(null)
  const [typing, setTyping] = useState<Partial<TextStyle> | null>(null)
  const editRef = useRef(edit)
  editRef.current = edit
  const selRef = useRef(selection)
  selRef.current = selection
  // Re-render (and re-lay-out the open text's carets) when a face arrives.
  const fontsV = useSyncExternalStore(subscribeFonts, fontsVersion)

  /**
   * Replace texts by id with `fn(data)`, laid out. Loads any face the result
   * needs first; `live` merges the commit into the running undo entry.
   */
  const apply = useCallback(
    (ids: readonly string[], fn: (data: TextData, id: string) => TextData, live: string | null) => {
      const run = () => {
        let doc = docRef.current
        for (const id of ids) {
          const it = findItem(doc.items, id)
          if (!it || !isText(it)) continue
          const next = layoutGroup({ ...it, text: fn(it.text, id) }, lookupFace).group
          doc = { ...doc, items: replaceItem(doc.items, id, next) }
        }
        if (doc === docRef.current) return
        commitNow(doc, live)
      }
      const docNow = docRef.current
      const needs = ids.flatMap((id) => {
        const it = findItem(docNow.items, id)
        return it && isText(it) ? facesUsed(fn(it.text, id)) : []
      })
      if (needs.every((f) => lookupFace(f.font, f.italic))) run()
      else void loadFontsFor(needs).then(run)
    },
    [docRef, commitNow],
  )

  const begin = useCallback(
    (id: string, caret: number | 'end' | 'all' = 'end') => {
      const it = findItem(docRef.current.items, id)
      if (!it || !isText(it)) return
      const len = plainText(it.text).length
      const at = caret === 'end' || caret === 'all' ? len : Math.max(0, Math.min(len, caret))
      setSelection(new Set([id]))
      setTyping(null)
      setEdit({ id, anchor: caret === 'all' ? 0 : at, focus: at })
      // The outlines may predate a font that has since loaded (or was never
      // loaded this session): load and relayout so carets match the glyphs.
      void loadFontsFor(facesUsed(it.text))
    },
    [docRef, setSelection],
  )

  const end = useCallback(() => {
    const e = editRef.current
    if (!e) return
    setEdit(null)
    setTyping(null)
    // An empty text leaves nothing behind, as in every editor.
    const it = findItem(docRef.current.items, e.id)
    if (it && isText(it) && plainText(it.text).length === 0) {
      const d = docRef.current
      commitNow({ ...d, items: removeItems(d.items, new Set([e.id])) })
      setSelection(new Set())
    }
  }, [docRef, commitNow, setSelection])

  const create = useCallback(
    (at: Vec, pathId: string | null = null) => {
      const doc = docRef.current
      const size = Math.max(4, Math.round(doc.viewBox[2] / 10))
      let data = newTextData(at, size)
      const id = newId('t')
      const path = pathId ? findItem(doc.items, pathId) : null
      if (path && path.kind === 'path' && path.subPaths[0]?.nodes.length > 1) {
        // The text starts where the curve was clicked, as in Affinity.
        const start = pathFraction(path.subPaths[0], at)
        data = { ...data, matrix: [1, 0, 0, 1, 0, 0], onPath: { path: path.subPaths[0], start } }
        if (path.fill !== 'none') data.style = { ...data.style, fill: path.fill }
      }
      const place = (d: EditableDoc) => {
        const group = makeTextGroup(id, data, lookupFace)
        // Along a path the text takes the path's place in the stack; else on top.
        const items = path ? replaceItem(d.items, path.id, group) : [...d.items, group]
        commitNow({ ...d, items })
        setSelection(new Set([id]))
        setTyping(null)
        setEdit({ id, anchor: 0, focus: 0 })
      }
      if (lookupFace(data.style.font, false)) place(doc)
      else void loadFontsFor(facesUsed(data)).then(() => place(docRef.current))
    },
    [docRef, commitNow, setSelection],
  )

  const setRange = useCallback((anchor: number, focus: number) => {
    setEdit((e) => (e ? { ...e, anchor, focus } : e))
    setTyping(null)
  }, [])

  const input = useCallback(
    (value: string, selStart: number, selEnd: number) => {
      const e = editRef.current
      if (!e) return
      const it = findItem(docRef.current.items, e.id)
      if (!it || !isText(it)) return
      const old = plainText(it.text)
      if (value !== old) {
        // The textarea owns the editing (IME, clipboard, word deletes); read the
        // change back as one replaced span.
        let pre = 0
        while (pre < old.length && pre < value.length && old[pre] === value[pre]) pre++
        let suf = 0
        while (
          suf < old.length - pre &&
          suf < value.length - pre &&
          old[old.length - 1 - suf] === value[value.length - 1 - suf]
        )
          suf++
        const typed = typing ?? undefined
        apply(
          [e.id],
          (d) => replaceText(d, pre, old.length - suf, value.slice(pre, value.length - suf), typed),
          `text:${e.id}`,
        )
      }
      setEdit({ id: e.id, anchor: selStart, focus: selEnd })
    },
    [docRef, apply, typing],
  )

  const restyle = useCallback(
    (patch: Partial<TextStyle>, live = false) => {
      const e = editRef.current
      if (e) {
        const a = Math.min(e.anchor, e.focus)
        const b = Math.max(e.anchor, e.focus)
        if (a === b && plainText((findItem(docRef.current.items, e.id) as GroupItem).text!).length > 0) {
          setTyping((t) => ({ ...t, ...patch }))
          return
        }
        apply(
          [e.id],
          (d) => styleRange(d, a === b ? 0 : a, a === b ? Number.MAX_SAFE_INTEGER : b, patch),
          live ? `textstyle:${e.id}` : null,
        )
        return
      }
      const ids = [...selRef.current]
      apply(ids, (d) => styleRange(d, 0, Number.MAX_SAFE_INTEGER, patch), live ? `textstyle:${ids.join(',')}` : null)
    },
    [docRef, apply],
  )

  const setProps = useCallback(
    (patch: Partial<Pick<TextData, 'align' | 'lineHeight' | 'kerning' | 'onPath'>>, live = false) => {
      const ids = editRef.current ? [editRef.current.id] : [...selRef.current]
      apply(ids, (d) => ({ ...d, ...patch }), live ? `textprops:${ids.join(',')}` : null)
    },
    [apply],
  )

  const shownStyle = useCallback(
    (data: TextData) => {
      const e = editRef.current
      if (!e) return rangeStyle(data, 0, plainText(data).length || 0)
      const a = Math.min(e.anchor, e.focus)
      const b = Math.max(e.anchor, e.focus)
      return { ...rangeStyle(data, a, b), ...(a === b ? typing : null) }
    },
    [typing],
  )

  // The open text vanished (undo past its creation, deleted from the layers).
  const doc = docRef.current
  const open = edit ? findItem(doc.items, edit.id) : null
  useEffect(() => {
    if (edit && (!open || !isText(open))) {
      setEdit(null)
      setTyping(null)
    }
  }, [edit, open])

  // Caret geometry for the overlay. Recomputed from the CURRENT layout so a
  // font that loaded after the outlines were cached still lines up.
  const layout: TextLayout | null = useMemo(
    () => (open && isText(open) ? layoutGroup(open, lookupFace).layout : null),
    // fontsV: a face that just loaded changes the answer for the same item.
    [open, fontsV],
  )

  return { edit, layout, typing, begin, create, end, setRange, input, restyle, setProps, shownStyle }
}
