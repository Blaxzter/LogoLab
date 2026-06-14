// Cleanup tab: the shared drop-zone empty state until a logo is loaded, then the
// full-height cleanup studio (removal controls, painting canvas, status bar)
// takes over the whole viewport. Mirrors VectorizePanel.

import { Eraser } from 'lucide-react'
import { useLogo } from '../../store'
import { PanelEmptyState } from '../PanelEmptyState'
import { CleanupStudio } from '../cleanup/CleanupStudio'

export default function CleanupPanel() {
  const logo = useLogo()

  if (!logo.src) {
    return (
      <div className="mx-auto max-w-5xl p-6">
        <PanelEmptyState
          icon={<Eraser size={26} />}
          title="No image to clean up"
          subtitle="Drop a PNG/JPG logo (or load an example) to remove its background."
        />
      </div>
    )
  }

  return <CleanupStudio />
}
