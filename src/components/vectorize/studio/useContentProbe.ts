// Probes each new image once: gradients on/off from its content, and the ink decision.

import { useEffect, type RefObject } from 'react'
import { getImageData } from '../../../lib/image'
import { suggestGradients } from '../../../lib/trace'
import type { InkColorMode } from '../../../lib/traceInput/ink'
import { probeShouldApply } from '../probeLedger'
import type { SetOpts, VectorizeSource } from './types'

export function useContentProbe({
  logo,
  assetKey,
  isVectorSource,
  retraceVector,
  applyInkDecision,
  setOpts,
  gradientsTouchedRef,
  autoGradientsSrcRef,
  decidedForRef,
  probePixelsRef,
  colorModeRef,
}: {
  logo: VectorizeSource
  assetKey: string
  isVectorSource: boolean
  retraceVector: 'clean' | 'retrace'
  applyInkDecision: (mode: InkColorMode, pixels?: ImageData | null, apply?: boolean) => void
  setOpts: SetOpts
  gradientsTouchedRef: RefObject<boolean>
  autoGradientsSrcRef: RefObject<string | null>
  decidedForRef: RefObject<string | null>
  probePixelsRef: RefObject<ImageData | null>
  colorModeRef: RefObject<InkColorMode>
}) {
  // Auto-default the gradients toggle from image content: flat art ⇒ off, real
  // ramps ⇒ on. Only a suggestion: a manual flip is never overridden, and each
  // image is probed once.
  // biome-ignore lint/correctness/useExhaustiveDependencies(autoGradientsSrcRef): a ref, read when the code runs
  // biome-ignore lint/correctness/useExhaustiveDependencies(colorModeRef.current): a ref, read when the code runs
  // biome-ignore lint/correctness/useExhaustiveDependencies(gradientsTouchedRef.current): a ref, read when the code runs
  // biome-ignore lint/correctness/useExhaustiveDependencies(setOpts): a state setter, stable
  // biome-ignore lint/correctness/useExhaustiveDependencies(gradientsTouchedRef): a ref, read when the code runs
  // biome-ignore lint/correctness/useExhaustiveDependencies(probePixelsRef): a ref, read when the code runs
  // biome-ignore lint/correctness/useExhaustiveDependencies(decidedForRef.current): a ref, read when the code runs
  // biome-ignore lint/correctness/useExhaustiveDependencies(autoGradientsSrcRef.current): a ref, read when the code runs
  // biome-ignore lint/correctness/useExhaustiveDependencies(decidedForRef): a ref, read when the code runs
  useEffect(() => {
    const src = logo.src
    if (!src) return
    // Cleaned vector sources don't run the tracer, so the toggle is moot.
    if (isVectorSource && retraceVector === 'clean') return
    if (autoGradientsSrcRef.current === src) return
    // Fresh image: re-enable the auto-decision. A restored image keeps its flags.
    const restoring = !probeShouldApply(decidedForRef.current, assetKey)
    if (!restoring) gradientsTouchedRef.current = false
    let cancelled = false
    void (async () => {
      try {
        const img = await getImageData(src, 512, logo.isSvg ? logo.svgText : null)
        // Claim after the decode, not before: under StrictMode the effect runs
        // twice, and claiming before the await would let the cancelled first run
        // mark the image done so the live run applies nothing.
        if (cancelled || gradientsTouchedRef.current) return
        autoGradientsSrcRef.current = src // probe once per image
        // The ink probe reuses the same decode; the pixels are kept so a manual
        // Mode change can re-decide without decoding again.
        probePixelsRef.current = img
        // On a restore the probe only measures (see decidedForRef). Either way the
        // options now stand decided for this image, so a new upload probes afresh.
        decidedForRef.current = assetKey
        applyInkDecision(colorModeRef.current, img, !restoring)
        if (restoring) return
        const on = suggestGradients(img)
        setOpts((o) => {
          // Skip if the user beat the probe, or it matches the effective
          // state already (avoid a spurious re-trace).
          if (gradientsTouchedRef.current) return o
          const currentlyOn = o.gradients !== false
          return currentlyOn === on ? o : { ...o, gradients: on }
        })
      } catch {
        // Best-effort: on decode failure leave the default in place.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [logo.src, logo.isSvg, logo.svgText, assetKey, isVectorSource, retraceVector, applyInkDecision])
}
