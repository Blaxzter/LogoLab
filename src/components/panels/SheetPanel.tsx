import { useSheetStore } from '../../sheetStore'
import { SheetIntake } from '../sheet/SheetIntake'
import { SheetStudio } from '../sheet/SheetStudio'

/**
 * The icon-sheet tab: split one image of many icons into many icons, each traced
 * by the same vectorizer the single-logo tab uses.
 */
export default function SheetPanel() {
  const source = useSheetStore((s) => s.source)
  return source ? <SheetStudio /> : <SheetIntake />
}
