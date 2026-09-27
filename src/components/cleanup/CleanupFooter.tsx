// The cleanup studio's bottom bars: the desktop status bar and the mobile action bar.

import { Check, Download, SlidersHorizontal } from 'lucide-react'
import type { CleanupTool } from '../../hooks/useCleanupCanvas'
import { Button } from '../ui/Button'
import { StudioActionBar, BarIconButton } from '../studio/StudioBar'
import { LegalLinksInline } from '../legal/LegalFooter'

/** Desktop status bar: last action, legal links, buffer size and the tool hint. */
export function CleanupStatusBar({
  status,
  dims,
  tool,
}: {
  status: string
  dims: { w: number; h: number } | null
  tool: CleanupTool
}) {
  return (
    <footer className="hidden h-9 shrink-0 items-center gap-4 border-t border-line bg-surface px-3 font-mono text-xs tabular-nums text-muted md:flex">
      <span className="truncate">
        {status || 'Scroll to zoom · Space- or middle-drag to pan · try AI or Auto first.'}
      </span>
      <LegalLinksInline className="mx-auto shrink-0" />
      <span className="flex shrink-0 items-center gap-3">
        {dims && (
          <span>
            {dims.w}×{dims.h}
          </span>
        )}
        <span className="hidden sm:inline">{toolStatusHint(tool)}</span>
      </span>
    </footer>
  )
}

/** Mobile action bar: open the tool sheet, Download, Apply. */
export function CleanupActionBar({
  onTools,
  onDownload,
  onApply,
  applied,
  modified,
  aiBusy,
  ready,
}: {
  onTools: () => void
  onDownload: () => void
  onApply: () => void
  applied: boolean
  modified: boolean
  aiBusy: boolean
  ready: boolean
}) {
  return (
    <StudioActionBar>
      <Button variant="secondary" className="h-10" icon={<SlidersHorizontal size={16} />} onClick={onTools}>
        Tools
      </Button>
      <div className="flex-1" />
      <BarIconButton title="Download PNG" onClick={onDownload} disabled={aiBusy || !ready}>
        <Download size={18} />
      </BarIconButton>
      <Button
        variant="primary"
        className="h-10"
        icon={applied ? <Check size={16} /> : undefined}
        onClick={onApply}
        disabled={(!modified && !applied) || aiBusy || !ready}
      >
        {applied ? 'Applied' : 'Apply'}
      </Button>
    </StudioActionBar>
  )
}

/** Footer hint per tool — the right-hand "how to use this tool" line. */
function toolStatusHint(tool: CleanupTool): string {
  switch (tool) {
    case 'magic':
      return 'Click to flood-remove the connected background'
    case 'color':
      return 'Click a color to remove it everywhere'
    case 'erase':
      return 'Drag to rub out pixels'
    case 'restore':
      return 'Drag to paint the original back'
    case 'keep':
      return 'Click to restore that region'
    case 'remove':
      return 'Click to remove that region'
  }
}
