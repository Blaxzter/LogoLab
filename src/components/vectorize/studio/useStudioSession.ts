// The studio's stored session: read once on mount, saved as settings and the document change.

import { useEffect, useRef, type RefObject } from 'react'
import type { EditableDoc } from '../../../lib/path/types'
import type { InkColorMode } from '../../../lib/traceInput/ink'
import type { VectorizeOptions } from '../../../types'
import { loadStudioSeed, saveStudioDoc, saveStudioView, type StudioSeed } from '../studioSession'
import type { MarkMode, ViewMode } from './types'

export function useStudioSession(persist: boolean, assetKey: string): StudioSeed {
  // The stored session, read once into a ref: the state initializers need it on
  // the first render, and a claimed document must not be claimed twice under
  // StrictMode's double invocation.
  const sessionRef = useRef<StudioSeed | undefined>(undefined)
  if (sessionRef.current === undefined) {
    sessionRef.current = persist ? loadStudioSeed(assetKey) : { view: null, doc: null, dirty: false }
  }
  return sessionRef.current
}

export function useSessionSave({
  persist,
  assetKey,
  doc,
  dirtyRef,
  opts,
  colorMode,
  forceColorOn,
  forceColor,
  forceColorTouchedRef,
  gradientsTouchedRef,
  decidedForRef,
  retraceVector,
  viewMode,
  overlayOpacity,
  markMode,
}: {
  persist: boolean
  assetKey: string
  doc: EditableDoc | null
  dirtyRef: RefObject<boolean>
  opts: VectorizeOptions
  colorMode: InkColorMode
  forceColorOn: boolean
  forceColor: string
  forceColorTouchedRef: RefObject<boolean>
  gradientsTouchedRef: RefObject<boolean>
  decidedForRef: RefObject<string | null>
  retraceVector: 'clean' | 'retrace'
  viewMode: ViewMode
  overlayOpacity: number
  markMode: MarkMode
}) {
  // Settings go to localStorage so they apply synchronously on the next mount.
  // The two "touched" flags are refs; they only change alongside a value in the
  // dependency list, so this effect sees them fresh.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the refs are the studio's, stable
  useEffect(() => {
    if (!persist) return
    saveStudioView({
      opts,
      colorMode,
      forceColorOn,
      forceColor,
      forceColorTouched: forceColorTouchedRef.current,
      gradientsTouched: gradientsTouchedRef.current,
      probedAssetKey: decidedForRef.current,
      retraceVector,
      viewMode,
      overlayOpacity,
      markMode,
    })
  }, [persist, opts, colorMode, forceColorOn, forceColor, retraceVector, viewMode, overlayOpacity, markMode])

  // The document goes to IndexedDB, keyed to its source image. Save the history
  // value, not `derivedDoc`: force colour is a view, and baking it in would lose
  // the real fills. Don't delete the slot on a null doc: it is null for one
  // commit on mount before the seed lands.
  // biome-ignore lint/correctness/useExhaustiveDependencies: dirtyRef is the studio's, stable
  useEffect(() => {
    if (!persist || !doc) return
    saveStudioDoc(assetKey, doc, dirtyRef.current)
  }, [persist, assetKey, doc])
}
