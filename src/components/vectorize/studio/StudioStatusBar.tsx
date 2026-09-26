// The desktop status bar: result stats, the ΔE readout, trace progress, errors and hints.

import { Loader2, X } from 'lucide-react'
import type { TraceScore } from '../../../lib/render/scoreOffThread'
import { LegalLinksInline } from '../../legal/LegalFooter'
import { ReportFailureLink } from '../../report/ReportIssue'
import { Tooltip } from '../../ui/Tooltip'
import type { Tool, ViewMode } from './types'

/** Human-readable byte size ('842 B' / '12.4 KB' / '1.20 MB'). */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 2 : 1)} KB`
  return `${(kb / 1024).toFixed(2)} MB`
}

export function StudioStatusBar({
  stats,
  svgBytes,
  score,
  setViewMode,
  busy,
  progress,
  stop,
  error,
  failure,
  tool,
}: {
  stats: { paths: number; nodes: number; colors: number } | null
  svgBytes: number
  score: TraceScore | null
  setViewMode: (v: ViewMode) => void
  busy: boolean
  progress: string
  stop: () => void
  error: string | null
  failure: unknown
  tool: Tool
}) {
  return (
    <footer className="hidden h-9 shrink-0 items-center gap-4 border-t border-line bg-surface px-3 font-mono text-xs tabular-nums text-muted md:flex">
      {stats && (
        <span className="shrink-0">
          {stats.paths} paths · {stats.nodes} nodes · {stats.colors} colors · {formatBytes(svgBytes)}
        </span>
      )}
      {/* The accuracy readout. A button because it and the Difference view
                are the same measurement. */}
      {score && (
        <Tooltip
          label={`Mean colour difference from the original: ${score.meanDeltaE.toFixed(
            2,
          )} ΔE, with 95% of pixels under ${score.p95DeltaE.toFixed(
            2,
          )}. Below about 2.3 ΔE the eye cannot tell two colours apart. Click to see where.`}
        >
          <button
            type="button"
            onClick={() => setViewMode('difference')}
            className="shrink-0 rounded px-1 py-0.5 transition-colors hover:bg-surface-3 hover:text-ink"
          >
            ΔE {score.meanDeltaE.toFixed(2)}
          </button>
        </Tooltip>
      )}
      {busy && (
        <span className="flex shrink-0 items-center gap-1.5 text-accent">
          <Loader2 size={12} className="animate-spin" />
          {progress || 'Tracing…'}
          <button
            type="button"
            onClick={stop}
            className="ml-0.5 flex items-center gap-0.5 rounded px-1 py-0.5 text-ink-2 transition-colors hover:bg-surface-3 hover:text-bad"
            title="Stop tracing (keeps the current result)"
          >
            <X size={11} />
            Stop
          </button>
        </span>
      )}
      {error && (
        <span className="flex min-w-0 items-center gap-2 text-bad">
          <span className="truncate">{error}</span>
          {failure != null && <ReportFailureLink what="the vectorizer" error={failure} />}
        </span>
      )}
      <LegalLinksInline className="mx-auto shrink-0" />
      <span className="hidden truncate sm:block">
        {tool === 'node'
          ? 'Drag anchors · double-click segment to add a node · Del removes'
          : tool === 'mark'
            ? 'Click to keep a region as its own shape · click a marker to remove · mark both sides of an overlap'
            : 'Scroll to zoom · drag to pan'}
      </span>
    </footer>
  )
}
