// Region markers: placing and removing them, and the kind a click drops.

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { VectorizeOptions } from '../../../types'
import type { StudioSeed } from '../studioSession'
import type { MarkMode, SetOpts, Tool } from './types'

export function useMarkers({
  session,
  opts,
  setOpts,
  tool,
  setTool,
  isVectorSource,
  retraceVector,
}: {
  session: StudioSeed
  opts: VectorizeOptions
  setOpts: SetOpts
  tool: Tool
  setTool: (t: Tool) => void
  isVectorSource: boolean
  retraceVector: 'clean' | 'retrace'
}) {
  // Markers live in `opts.markers` so they flow into the trace and explainer,
  // survive a re-trace and pass through the worker. Coordinates are normalized
  // to [0,1].
  const markers = useMemo(() => opts.markers ?? [], [opts.markers])

  // Which kind of marker a click drops: "separate" (keep the region distinct, its
  // paint untouched), "flat" (also pin it to its pre-merge flat form + solid), or
  // "remove" (dissolve the section and heal its neighbours into the gap).
  const [markMode, setMarkMode] = useState<MarkMode>(session.view?.markMode ?? 'separate')

  // biome-ignore lint/correctness/useExhaustiveDependencies: setOpts is the studio's, stable
  const addMarker = useCallback(
    (x: number, y: number) => {
      const m = markMode === 'flat' ? { x, y, flat: true } : markMode === 'remove' ? { x, y, remove: true } : { x, y }
      setOpts((o) => ({ ...o, markers: [...(o.markers ?? []), m] }))
    },
    [markMode],
  )
  // biome-ignore lint/correctness/useExhaustiveDependencies: setOpts is the studio's, stable
  const removeMarker = useCallback((index: number) => {
    setOpts((o) => ({
      ...o,
      markers: (o.markers ?? []).filter((_, i) => i !== index),
    }))
  }, [])
  // biome-ignore lint/correctness/useExhaustiveDependencies: the setters are the studio's, stable
  const clearMarkers = useCallback(() => {
    setTool('pan')
    setOpts((o) => (o.markers && o.markers.length ? { ...o, markers: [] } : o))
  }, [])

  // Markers only apply to colour tracing; leaving that mode exits the placement
  // tool (the markers persist).
  // biome-ignore lint/correctness/useExhaustiveDependencies: setTool is the studio's, stable
  useEffect(() => {
    const colorTrace = (!isVectorSource || retraceVector === 'retrace') && opts.mode === 'color'
    if (!colorTrace && tool === 'mark') setTool('pan')
  }, [isVectorSource, retraceVector, opts.mode, tool])

  return { markers, markMode, setMarkMode, addMarker, removeMarker, clearMarkers }
}
