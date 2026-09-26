// Types shared by the vectorize studio's modules.

import type { Dispatch, SetStateAction } from 'react'
import type { VectorizeOptions } from '../../../types'

export type ViewMode = 'split' | 'traced' | 'original' | 'overlay' | 'difference'
export type Tool = 'pan' | 'node' | 'mark'
export type MarkMode = 'separate' | 'flat' | 'remove'

export type SetOpts = Dispatch<SetStateAction<VectorizeOptions>>

/** The fields of a `LogoAsset` the studio actually traces — a sheet tile supplies the same six. */
export interface VectorizeSource {
  src: string | null
  isSvg: boolean
  svgText: string | null
  naturalWidth: number
  naturalHeight: number
  fileName: string | null
}
