// "Find best settings" in the Vectorize rail: the button, the progress while the
// candidates run, and the scoreboard they leave behind. Controlled: the search
// lives in useBestSettings, the words in studio/bestSettings.ts.

import { Check, Loader2, Sparkles, X } from '../ui/icons'
import { ActionButton, isOff } from '../ui/ActionButton'
import { Tooltip } from '../ui/Tooltip'
import { SEARCH_MAX_DIM, scoreLine, winnerNote, type CandidateId } from './studio/bestSettings'
import type { BestSettingsState, ScoredCandidate } from './studio/useBestSettings'

export interface BestSettingsProps {
  state: BestSettingsState
  /** Non-empty ⇒ the button is unavailable, and this says why. */
  reason: string | null
  /** The candidate the current settings match, if any (the scoreboard ticks it). */
  appliedId: CandidateId | null
  onStart: () => void
  onCancel: () => void
  onApply: (c: ScoredCandidate) => void
  onDismiss: () => void
}

// Every root below is `shrink-0`: the rail is a scrolling flex column, and once
// it overflows (always, in the mobile sheet) a shrinkable row gets squashed.
export function BestSettings({ state, reason, appliedId, onStart, onCancel, onApply, onDismiss }: BestSettingsProps) {
  if (state.status === 'running') {
    return (
      <div className="flex shrink-0 items-center gap-2 rounded-md border border-line bg-surface-2 px-3 py-2 text-xs text-ink-2">
        <Loader2 size={14} className="shrink-0 animate-spin text-accent" />
        <span className="flex-1" aria-live="polite">
          Trying {Math.min(state.done + 1, state.total)} of {state.total}…
        </span>
        <button type="button" onClick={onCancel} className="btn btn-ghost h-6 gap-1 px-2 text-xs">
          <X size={12} />
          Cancel
        </button>
      </div>
    )
  }

  const off = isOff(reason)
  const button = (
    <ActionButton
      label="Find best settings"
      reason={reason}
      note={`Traces a few settings on a ${SEARCH_MAX_DIM}px copy, scores each against your image, and applies the closest match.`}
      onClick={onStart}
      className={`btn btn-secondary h-8 w-full shrink-0 gap-1.5 text-xs ${off ? 'cursor-not-allowed opacity-50' : ''}`}
    >
      <Sparkles size={14} />
      {state.status === 'done' ? 'Find best settings again' : 'Find best settings'}
    </ActionButton>
  )

  if (state.status === 'error') {
    return (
      <div className="flex shrink-0 flex-col gap-2">
        {button}
        <p className="text-xs leading-snug text-warn">{state.message}</p>
      </div>
    )
  }
  if (state.status !== 'done') return button

  const note = winnerNote(state.ranked)
  return (
    <div className="flex shrink-0 flex-col gap-2">
      <div className="rounded-md border border-line bg-surface-2 text-xs">
        <div className="flex items-center justify-between px-3 pt-2 pb-1">
          <span className="font-semibold text-ink">Best for this image</span>
          <Tooltip label="Hide the scoreboard">
            <button
              type="button"
              onClick={onDismiss}
              aria-label="Hide the scoreboard"
              className="btn btn-ghost -mr-1.5 h-6 w-6 p-0 text-muted"
            >
              <X size={13} />
            </button>
          </Tooltip>
        </div>
        <ul className="flex flex-col pb-1">
          {state.ranked.map((s, i) => {
            const applied = s.id === appliedId
            return (
              <li key={s.id}>
                <Tooltip label={applied ? 'These are the current settings' : `Apply ${s.candidate.label}`}>
                  <button
                    type="button"
                    onClick={applied ? undefined : () => onApply(s)}
                    aria-current={applied || undefined}
                    className={`flex w-full items-center gap-2 px-3 py-1 text-left ${
                      applied ? 'text-ink' : 'text-ink-2 hover:bg-surface-3'
                    }`}
                  >
                    <span className="flex w-3.5 shrink-0 justify-center text-accent">
                      {applied && <Check size={13} />}
                    </span>
                    <span className={`flex-1 truncate ${i === 0 ? 'font-medium' : ''}`}>{s.candidate.label}</span>
                    <span className="shrink-0 tabular-nums text-muted">{scoreLine(s)}</span>
                  </button>
                </Tooltip>
              </li>
            )
          })}
        </ul>
        <p className="border-t border-line px-3 py-1.5 leading-snug text-faint">
          {note ? `${note} ` : ''}Compared at {SEARCH_MAX_DIM}px in {(state.ms / 1000).toFixed(1)} s.
        </p>
      </div>
      {button}
    </div>
  )
}
