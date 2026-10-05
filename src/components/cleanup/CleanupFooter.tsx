// The cleanup studio's bottom bars: the desktop status bar and the mobile action bar.

import { Download, SlidersHorizontal } from '../ui/icons'
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
    <footer className="hidden h-9 shrink-0 items-center gap-4 border-t border-line bg-surface px-3 font-mono text-xs tabular-nums text-muted lg:flex">
      <span className="truncate">
        {status || 'Scroll to zoom · Space- or middle-drag to pan · try AI or Auto first.'}
      </span>
      <LegalLinksInline className="mx-auto shrink-0" />
      {/* The hint gives way too, or the status beside it — progress and errors —
          is the only thing that truncates. */}
      <span className="flex min-w-0 items-center gap-3">
        {dims && (
          <span className="shrink-0">
            {dims.w}×{dims.h}
          </span>
        )}
        <span className="hidden min-w-0 truncate sm:block">{toolStatusHint(tool)}</span>
      </span>
    </footer>
  )
}

/** Mobile action bar: open the tool sheet, Download. */
export function CleanupActionBar({
  onTools,
  onDownload,
  aiBusy,
  ready,
}: {
  onTools: () => void
  onDownload: () => void
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
    </StudioActionBar>
  )
}

/** Footer hint per tool — the right-hand "how to use this tool" line. */
function toolStatusHint(tool: CleanupTool): string {
  switch (tool) {
    case 'magic':
      return 'Click to remove the connected background'
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
