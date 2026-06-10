// Vectorize tab: the shared drop-zone empty state until a logo is loaded,
// then the full-height vectorize studio (trace controls, node-editing canvas,
// paths panel) takes over the whole viewport.

import { ImageOff } from 'lucide-react'
import { useLogo } from '../../store'
import { PanelEmptyState } from '../PanelEmptyState'
import { VectorizeStudio } from '../vectorize/VectorizeStudio'

export default function VectorizePanel() {
  const logo = useLogo()

  if (!logo.src) {
    return (
      <div className="mx-auto max-w-6xl p-6">
        <PanelEmptyState
          icon={<ImageOff size={26} />}
          title="No logo to vectorize"
          subtitle="Drop a PNG, JPG, or SVG (or load an example) to trace it to clean vector paths."
        />
      </div>
    )
  }

  return <VectorizeStudio />
}
