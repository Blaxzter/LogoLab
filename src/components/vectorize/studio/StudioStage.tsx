// The stage: the active view's panes, the empty-result notice, trace progress and the mark cue.

import type { ComponentProps } from 'react'
import { AlertTriangle, Loader2, MapPin, X } from 'lucide-react'
import type { PanZoom } from '../../../hooks/usePanZoom'
import type { EditableDoc } from '../../../lib/path/types'
import type { TraceScore } from '../../../lib/render/scoreOffThread'
import { Button } from '../../ui/Button'
import { EditorCanvas } from '../EditorCanvas'
import { DiffPane } from './DiffPane'
import { OriginalPane } from './OriginalPane'
import type { MarkMode, Tool, ViewMode } from './types'
import type { EmptyNotice } from './useEmptyNotice'

export type CanvasShared = Omit<ComponentProps<typeof EditorCanvas>, 'doc' | 'primary' | 'underlay'>

export function StudioStage({
  view,
  checkerClass,
  tool,
  setTool,
  markMode,
  pz,
  logo,
  markers,
  addMarker,
  removeMarker,
  canvasShared,
  derivedDoc,
  busy,
  progress,
  progressFraction,
  stop,
  overlayOpacity,
  score,
  canScore,
  emptyNotice,
}: {
  view: ViewMode
  checkerClass: string
  tool: Tool
  setTool: (t: Tool) => void
  markMode: MarkMode
  pz: PanZoom
  logo: { src: string; naturalWidth: number; naturalHeight: number }
  markers: { x: number; y: number; flat?: boolean; remove?: boolean }[]
  addMarker: (x: number, y: number) => void
  removeMarker: (index: number) => void
  canvasShared: CanvasShared
  derivedDoc: EditableDoc | null
  busy: boolean
  progress: string
  progressFraction: number
  stop: () => void
  overlayOpacity: number
  score: TraceScore | null
  canScore: boolean
  emptyNotice: EmptyNotice | null
}) {
  return (
    <div
      className={`relative min-h-0 flex-1 ${checkerClass} ${
        tool === 'mark' ? 'ring-2 ring-inset ring-emerald-400/70' : ''
      }`}
    >
      {view === 'split' && (
        <div className="grid h-full grid-cols-2">
          <div className="relative h-full min-w-0 border-r border-line">
            <OriginalPane
              pz={pz}
              src={logo.src}
              aspectW={logo.naturalWidth || 1}
              aspectH={logo.naturalHeight || 1}
              primary
              markers={markers}
              marking={tool === 'mark'}
              onAddMarker={addMarker}
              onRemoveMarker={removeMarker}
            />
            <Chip>Original</Chip>
          </div>
          <div className="relative h-full min-w-0">
            {derivedDoc ? <EditorCanvas {...canvasShared} doc={derivedDoc} /> : <StagePlaceholder busy={busy} />}
            <Chip>Traced</Chip>
          </div>
        </div>
      )}
      {view === 'traced' &&
        (derivedDoc ? <EditorCanvas {...canvasShared} doc={derivedDoc} primary /> : <StagePlaceholder busy={busy} />)}
      {view === 'original' && (
        <OriginalPane
          pz={pz}
          src={logo.src}
          aspectW={logo.naturalWidth || 1}
          aspectH={logo.naturalHeight || 1}
          primary
          markers={markers}
          marking={tool === 'mark'}
          onAddMarker={addMarker}
          onRemoveMarker={removeMarker}
        />
      )}
      {view === 'overlay' &&
        (derivedDoc ? (
          <EditorCanvas
            {...canvasShared}
            doc={derivedDoc}
            primary
            underlay={{
              src: logo.src,
              opacity: overlayOpacity / 100,
            }}
          />
        ) : (
          <StagePlaceholder busy={busy} />
        ))}
      {view === 'difference' &&
        (score ? (
          <DiffPane pz={pz} score={score} primary />
        ) : (
          <StagePlaceholder
            busy={busy}
            idle={!derivedDoc ? 'No result yet' : canScore ? 'Measuring…' : "This browser can't measure the difference"}
          />
        ))}

      {/* Empty-result notice, centred on the traced pane (the right half in
                split view). Not shown over "original". */}
      {emptyNotice && view !== 'original' && (
        <div
          className={`animate-in-fade pointer-events-none absolute inset-y-0 z-10 flex items-center justify-center p-6 ${
            view === 'split' ? 'left-1/2 right-0' : 'inset-x-0'
          }`}
        >
          <div className="pointer-events-auto max-w-xs rounded-xl border border-warn/40 bg-surface/95 p-4 text-center shadow-lg backdrop-blur">
            <AlertTriangle size={20} className="mx-auto mb-2 text-warn" />
            <p className="text-xs leading-snug text-ink-2">{emptyNotice.text}</p>
            {emptyNotice.action && (
              <Button variant="primary" className="mt-3 h-8 px-3 text-xs" onClick={emptyNotice.action.run}>
                {emptyNotice.action.label}
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Trace-in-progress overlay. pointer-events-none keeps pan/zoom live
                while the trace runs off-thread. */}
      {busy && (
        <div className="animate-in-fade pointer-events-none absolute inset-0 overflow-hidden">
          {progressFraction <= 0 && <div className="trace-sweep" />}
          <div className="absolute left-1/2 top-3 w-64 max-w-[80%] -translate-x-1/2">
            <div className="pointer-events-auto rounded-xl border border-line bg-surface/90 px-3 py-2 shadow-sm backdrop-blur">
              <div className="flex items-center gap-2 text-xs font-medium text-accent">
                <Loader2 size={13} className="shrink-0 animate-spin" />
                <span className="min-w-0 flex-1 truncate">{progress || 'Tracing…'}</span>
                {progressFraction > 0 && (
                  <span className="shrink-0 tabular-nums text-ink-2">{Math.round(progressFraction * 100)}%</span>
                )}
                <button
                  type="button"
                  onClick={stop}
                  className="-mr-1 flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-ink-2 transition-colors hover:bg-surface-3 hover:text-bad"
                  title="Stop tracing (keeps the current result)"
                >
                  <X size={12} />
                  Stop
                </button>
              </div>
              <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-surface-3">
                <div
                  className={`h-full rounded-full bg-accent ${progressFraction > 0 ? 'transition-[width] duration-200 ease-out' : 'animate-pulse'}`}
                  style={{ width: `${Math.max(5, Math.round(progressFraction * 100))}%` }}
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* On-stage cue that the canvas is in marker-placement mode. */}
      {tool === 'mark' && !busy && (
        <div className="animate-in-fade pointer-events-none absolute left-1/2 top-3 z-10 -translate-x-1/2">
          <span
            className={`flex items-center gap-2 rounded-full border bg-surface/90 px-3 py-1 text-xs font-medium shadow-sm backdrop-blur ${
              markMode === 'flat'
                ? 'border-amber-400/50 text-amber-600 dark:text-amber-400'
                : markMode === 'remove'
                  ? 'border-rose-400/50 text-rose-600 dark:text-rose-400'
                  : 'border-emerald-400/50 text-emerald-600 dark:text-emerald-400'
            }`}
          >
            <MapPin size={13} />
            {markMode === 'flat'
              ? 'Click a region to paint it one flat colour'
              : markMode === 'remove'
                ? 'Click a section to remove it and heal the neighbours in'
                : 'Click a region to keep it as its own shape'}
            <button
              type="button"
              onClick={() => setTool('pan')}
              className="pointer-events-auto -mr-1 ml-1 rounded-full px-2 py-0.5 text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink"
            >
              Done
            </button>
          </span>
        </div>
      )}
    </div>
  )
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="pointer-events-none absolute left-2 top-2 rounded border border-line bg-surface/80 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted backdrop-blur">
      {children}
    </span>
  )
}

function StagePlaceholder({ busy, idle = 'No result yet' }: { busy: boolean; idle?: string }) {
  return (
    <div className="flex h-full items-center justify-center">
      {busy ? (
        <Loader2 size={22} className="animate-spin text-muted" />
      ) : (
        <span className="text-xs text-muted">{idle}</span>
      )}
    </div>
  )
}
