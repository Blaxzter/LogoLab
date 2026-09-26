import { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { useSheetStore } from '../../sheetStore'
import { claim, type StoredSheet } from '../../lib/persist/session'
import { SheetIntake } from '../sheet/SheetIntake'
import { SheetStudio } from '../sheet/SheetStudio'

/**
 * The icon-sheet tab: split one image of many icons into many icons, each traced
 * by the same vectorizer the single-logo tab uses.
 *
 * The one route that restores asynchronously: a stored sheet must be decoded
 * back to pixels before its boxes mean anything, and doing that in the boot gate
 * (main.tsx) would make every cold start pay for a tab most sessions never open.
 */
export default function SheetPanel() {
  const source = useSheetStore((s) => s.source)
  const hydrate = useSheetStore((s) => s.hydrate)

  // Claimed in the render body so the "am I restoring?" answer is known before
  // the first paint — deciding it in an effect would flash the intake screen and
  // then replace it with a sheet.
  const stored = useRef<StoredSheet | null | undefined>(undefined)
  if (stored.current === undefined) stored.current = source ? null : claim('sheet')
  const [restoring, setRestoring] = useState(Boolean(stored.current))

  useEffect(() => {
    const record = stored.current
    if (!record) return
    let alive = true
    void hydrate(record).finally(() => {
      if (alive) setRestoring(false)
    })
    return () => {
      alive = false
    }
  }, [hydrate])

  if (restoring) {
    return (
      <div className="flex items-center justify-center gap-2 py-24 text-sm text-muted">
        <Loader2 size={16} className="animate-spin text-accent" />
        Restoring your sheet…
      </div>
    )
  }

  return source ? <SheetStudio /> : <SheetIntake />
}
