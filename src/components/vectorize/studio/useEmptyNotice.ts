// Explains an empty trace on the canvas, with a one-click fix when there is one.

import { useMemo, type RefObject } from 'react'
import type { docStats } from '../../../lib/path/model'
import type { EditableDoc } from '../../../lib/path/types'
import type { InkColorMode, InkModePlan } from '../../../lib/traceInput/ink'
import type { VectorizeOptions } from '../../../types'
import type { SetOpts } from './types'
import type { useInkDecision } from './useInkDecision'

export interface EmptyNotice {
  text: string
  action?: { label: string; run: () => void }
}

export function useEmptyNotice({
  busy,
  derivedDoc,
  stats,
  inkPlan,
  monoGuide,
  opts,
  setOpts,
  colorMode,
  setColorMode,
  colorModeRef,
  useMeasuredCut,
  applyInkDecision,
}: {
  busy: boolean
  derivedDoc: EditableDoc | null
  stats: ReturnType<typeof docStats> | null
  inkPlan: InkModePlan | null
  monoGuide: ReturnType<typeof useInkDecision>['monoGuide']
  opts: VectorizeOptions
  setOpts: SetOpts
  colorMode: InkColorMode
  setColorMode: (m: InkColorMode) => void
  colorModeRef: RefObject<InkColorMode>
  useMeasuredCut: () => void
  applyInkDecision: (mode: InkColorMode) => void
}) {
  /**
   * The trace came back empty: explain it on the canvas, where the user is
   * looking, with a one-click fix when there is one. The controls already flag
   * dead settings; this covers what slips through.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: the setters and colorModeRef are the studio's, stable
  return useMemo((): EmptyNotice | null => {
    if (busy || !derivedDoc || !stats || stats.paths > 0) return null

    // Nothing in the source to begin with; no setting recovers that.
    if (inkPlan?.inks === 0) {
      return {
        text: 'This image looks empty — every pixel matches its background, so there is nothing to trace.',
      }
    }

    // A mono cut with all the ink on the wrong side of it. The probe knows
    // which side works, so the fix is one button rather than an instruction.
    if (opts.mode === 'mono' && monoGuide) {
      const here = opts.invert ? monoGuide.fracOn : monoGuide.fracOff
      const there = opts.invert ? monoGuide.fracOff : monoGuide.fracOn
      if (here === 0 && there > 0) {
        return {
          text: `This cut selects no pixels, so nothing was traced. Inverting it selects ${
            there < 0.01 ? (there * 100).toFixed(1) : Math.round(there * 100)
          }% of the visible pixels.`,
          action: {
            label: 'Flip Invert',
            run: () => setOpts((o) => ({ ...o, invert: !o.invert })),
          },
        }
      }
      if (here === 0) {
        return {
          text: 'This threshold selects no pixels, so nothing was traced.',
          action: inkPlan ? { label: `Use the measured cut (${inkPlan.threshold})`, run: useMeasuredCut } : undefined,
        }
      }
    }

    // Everything else: say so plainly rather than guess at a cause.
    return {
      text: 'The trace came back empty — nothing in the image matched these settings.',
      action:
        colorMode !== 'auto'
          ? {
              label: 'Let Auto decide',
              run: () => {
                setColorMode('auto')
                colorModeRef.current = 'auto'
                applyInkDecision('auto')
              },
            }
          : undefined,
    }
  }, [busy, derivedDoc, stats, inkPlan, monoGuide, opts.mode, opts.invert, colorMode, useMeasuredCut, applyInkDecision])
}
