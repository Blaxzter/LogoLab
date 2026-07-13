import type { ReactNode } from 'react'
import { Loader2 } from 'lucide-react'

/** One corpus case: a heading with badges, a horizontal strip of panels, and whatever
 *  the page hangs underneath (a gate table, a paint-model list, a diagnostic note). */
export function CaseRow({
  title,
  note,
  badges,
  right,
  children,
  footer,
}: {
  title: string
  note?: ReactNode
  badges?: ReactNode
  right?: ReactNode
  children: ReactNode
  footer?: ReactNode
}) {
  return (
    <section className="border-b border-line px-4 py-4">
      <div className="mb-2.5 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        {note && <span className="text-[0.7rem] text-muted">{note}</span>}
        {badges}
        {right && <span className="ml-auto text-[0.7rem] text-faint">{right}</span>}
      </div>
      {/* items-stretch: every cell in a line takes the tallest cell's height. Inside a cell
          (see Panel) the caption then fills whatever is left above the box — so the LABELS
          line up at the top and the BOXES line up at the bottom, however many lines a note
          wraps to. Top-aligning the cells instead would push a box down under a 3-line note;
          bottom-aligning them would ragged the labels. */}
      <div className="flex flex-wrap items-stretch gap-3">{children}</div>
      {footer}
    </section>
  )
}

export type BadgeTone = 'ok' | 'warn' | 'bad' | 'neutral' | 'accent'

const BADGE_TONE: Record<BadgeTone, string> = {
  ok: 'bg-good/12 text-good',
  warn: 'bg-warn/12 text-warn',
  bad: 'bg-bad/12 text-bad',
  neutral: 'bg-surface-3 text-muted',
  accent: 'bg-accent-soft text-accent',
}

export function Badge({ tone = 'neutral', children }: { tone?: BadgeTone; children: ReactNode }) {
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[0.6rem] font-semibold uppercase tracking-wide ${BADGE_TONE[tone]}`}
    >
      {children}
    </span>
  )
}

/** The row placeholder shown while its case is being traced — keeps the page's shape
 *  stable so finished rows don't jump around underneath the cursor. */
export function PendingRow({ title, note }: { title: string; note?: ReactNode }) {
  return (
    <section className="border-b border-line px-4 py-4">
      <div className="mb-2.5 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        {note && <span className="text-[0.7rem] text-muted">{note}</span>}
        <Badge tone="accent">
          <span className="flex items-center gap-1">
            <Loader2 size={9} className="animate-spin" />
            tracing
          </span>
        </Badge>
      </div>
      <div className="flex flex-wrap items-start gap-3">
        <div className="lab-box animate-pulse rounded-lg border border-line bg-surface-3" />
      </div>
    </section>
  )
}

/** A boxed note under a row. `bad` = this case cannot be scored; `warn` = a caveat;
 *  `ok` = a reassurance; `info` = a diagnostic that is explicitly NOT a gate. */
export function NoteBox({
  tone,
  children,
}: {
  tone: 'ok' | 'warn' | 'bad' | 'info'
  children: ReactNode
}) {
  const cls = {
    ok: 'border-good/30 bg-good/8 text-good',
    warn: 'border-warn/30 bg-warn/8 text-warn',
    bad: 'border-bad/30 bg-bad/8 text-bad',
    info: 'border-line bg-surface-2 text-ink-2',
  }[tone]
  return (
    <div className={`lab-prose mt-2 rounded-md border px-2.5 py-1.5 text-[0.7rem] leading-relaxed ${cls}`}>
      {children}
    </div>
  )
}
