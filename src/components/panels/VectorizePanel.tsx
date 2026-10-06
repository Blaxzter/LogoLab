// Vectorize tab: the empty state until a logo is loaded, then the full-height
// vectorize studio.

import { ImageOff } from '../ui/icons'
import { useLogo, useStore } from '../../state/store'
import { PanelEmptyState } from '../intake/PanelEmptyState'
import { VectorizeStudio } from '../vectorize/VectorizeStudio'

export default function VectorizePanel() {
  const logo = useLogo()
  const studioEpoch = useStore((s) => s.studioEpoch)

  if (!logo.src) {
    return (
      <div className="mx-auto max-w-6xl p-6">
        <PanelEmptyState
          icon={<ImageOff size={26} />}
          title="No logo to vectorize"
          subtitle="Drop in a PNG, JPG or SVG, or load an example, to trace it into clean vector paths."
        />
      </div>
    )
  }

  // Only this studio persists: it owns the working logo. The sheet's per-tile
  // studios are persisted by the sheet store instead. Keyed on the epoch so a
  // removed logo takes its settings with it, even when the next upload lands
  // before React ever renders the empty state in between.
  return <VectorizeStudio key={studioEpoch} persist />
}
