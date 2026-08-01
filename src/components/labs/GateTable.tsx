import { Fragment } from 'react'
import type { ReactNode } from 'react'

/**
 * The gate table both scoring labs draw: one row per gate, a bar showing where the
 * value sits between "blessed/perfect" and "fails", and how much room is left.
 *
 * The shapes the two pages score differ (`GateRow` carries a golden to compare to,
 * `TruthGate` carries an absolute limit), but the RENDER is the same, and one rule is
 * load-bearing in both: **a gate with nothing to measure renders as `n/a`, never as a
 * pass.** `bg-ramp` scores a *perfect* 0.00 boundary error because its whole outline is
 * the canvas border and there is no interior boundary to compare; region recovery is
 * meaningless on gradient art. A gate that silently passes because it had nothing to
 * check is worse than no gate — so `tone: 'na'` prints n/a and says why.
 */
export type GateTone = 'ok' | 'warn' | 'tight' | 'fail' | 'na'

export interface GateBarRow {
  key: string
  label: string
  tone: GateTone
  /** The numeric columns between the label and the bar, in `columns` order. */
  cells: ReactNode[]
  /** Bar fill, 0–1. `null` draws an empty, dashed bar (nothing to fill: a zero-tolerance
   *  gate is pass/fail, an n/a gate had nothing to measure). */
  fill: number | null
  /** Caption inside the empty bar, e.g. "no tolerance" / "nothing to measure". */
  emptyLabel?: string
  /** The trailing summary — "38% left", "FAIL", "n/a". */
  head: ReactNode
  /** A sub-row explaining an n/a. */
  why?: ReactNode
}

const HEAD_TONE: Record<GateTone, string> = {
  ok: 'text-good',
  warn: 'text-warn',
  tight: 'text-orange-500',
  fail: 'text-bad',
  na: 'text-faint',
}

const FILL_TONE: Record<GateTone, string> = {
  ok: 'bg-good',
  warn: 'bg-warn',
  tight: 'bg-orange-500',
  fail: 'bg-bad',
  na: 'bg-transparent',
}

export function GateTable({
  columns,
  barLabel,
  rows,
}: {
  /** Headers for the numeric columns between "gate" and the bar. */
  columns: string[]
  barLabel: string
  rows: GateBarRow[]
}) {
  return (
    <table className="w-full border-collapse text-xs">
      <thead>
        <tr className="text-left text-[0.6rem] uppercase tracking-wide text-muted">
          <th className="border-b border-line py-1 pr-2 font-semibold">gate</th>
          {columns.map((c) => (
            <th key={c} className="border-b border-line py-1 pr-2 text-right font-semibold">
              {c}
            </th>
          ))}
          <th className="w-[34%] border-b border-line py-1 pr-2 font-semibold">{barLabel}</th>
          <th className="border-b border-line py-1 text-right font-semibold" />
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <Fragment key={r.key}>
            <tr className={r.tone === 'na' ? 'text-faint' : ''}>
              <td className="whitespace-nowrap border-b border-line/60 py-1 pr-2 font-semibold text-ink">
                {r.tone === 'na' ? <span className="text-faint">{r.label}</span> : r.label}
              </td>
              {r.cells.map((c, i) => (
                <td
                  key={i}
                  className="whitespace-nowrap border-b border-line/60 py-1 pr-2 text-right font-mono text-[0.68rem] tabular-nums"
                >
                  {c}
                </td>
              ))}
              <td className="border-b border-line/60 py-1 pr-2">
                {r.fill === null ? (
                  <div className="relative h-2 rounded-full border border-dashed border-line-strong">
                    <span className="absolute inset-0 text-center text-[0.55rem] leading-[6px] text-faint">
                      {r.emptyLabel}
                    </span>
                  </div>
                ) : (
                  <div className="h-2 overflow-hidden rounded-full bg-surface-3">
                    <div
                      className={`h-full rounded-full ${FILL_TONE[r.tone]}`}
                      style={{ width: `${Math.max(0, Math.min(1, r.fill)) * 100}%` }}
                    />
                  </div>
                )}
              </td>
              <td
                className={`whitespace-nowrap border-b border-line/60 py-1 text-right font-mono text-[0.68rem] font-bold tabular-nums ${HEAD_TONE[r.tone]}`}
              >
                {r.head}
              </td>
            </tr>
            {r.why && (
              <tr>
                <td colSpan={columns.length + 3} className="pb-1.5 text-[0.6rem] leading-snug text-faint">
                  {r.why}
                </td>
              </tr>
            )}
          </Fragment>
        ))}
      </tbody>
    </table>
  )
}

/** The panel a gate table sits in, with room for the ungated / diagnostic notes under it. */
export function GatePanel({ children }: { children: ReactNode }) {
  return <div className="panel mt-3 px-3 py-2.5">{children}</div>
}
