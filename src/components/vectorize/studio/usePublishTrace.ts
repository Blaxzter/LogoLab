// Writes the trace into the app's working logo as it changes, so Preview, the
// Editor and Export show it without an Apply step.
//
// The store keeps the image the trace was cut from as `traceInput`, so the studio
// goes on tracing that and never its own output (see `publishTrace`).

import { useEffect, useRef, type RefObject } from 'react'
import { useStore } from '../../../state/store'
import { debounce } from '../../../lib/persist/local'
import type { EditableDoc } from '../../../lib/path/types'

/** A node drag is one write, not one per pointer move (each re-serializes the doc into a blob). */
const PUBLISH_MS = 300

export function usePublishTrace({
  enabled,
  inputKey,
  svgText,
  derivedDoc,
  busy,
  cleanFromExisting,
  forceColorOn,
  dirtyRef,
}: {
  /** Off when a host owns the result (the icon sheet keeps its tiles itself). */
  enabled: boolean
  /** `assetKey` of the image being traced; a write for any other image is dropped. */
  inputKey: string
  svgText: string | null
  derivedDoc: EditableDoc | null
  busy: boolean
  cleanFromExisting: boolean
  forceColorOn: boolean
  dirtyRef: RefObject<boolean>
}) {
  const publish = useRef(
    debounce((svg: string, w: number, h: number, key: string) => {
      const s = useStore.getState()
      // The image changed under a pending write (an upload, a cleanup edit): this
      // trace belongs to the old one.
      if ((s.traceInput?.assetKey ?? s.assetKey) !== key) return
      if (s.logo.svgText === svg) return
      s.publishTrace(svg, w, h)
    }, PUBLISH_MS),
  ).current

  // Leaving the tab mid-debounce still lands the last edit.
  useEffect(() => () => publish.flush(), [publish])

  // biome-ignore lint/correctness/useExhaustiveDependencies(dirtyRef): a ref, read when the code runs
  useEffect(() => {
    if (!enabled || busy || !svgText || !derivedDoc) return
    // A Clean SVG pass the user hasn't changed is the working image already, just
    // re-serialized: writing it would turn merely opening the tab into an edit.
    if (cleanFromExisting && !dirtyRef.current && !forceColorOn) return
    const [, , w, h] = derivedDoc.viewBox
    publish(svgText, w, h, inputKey)
  }, [enabled, busy, svgText, derivedDoc, cleanFromExisting, forceColorOn, inputKey, publish])
}
