import { LogoMark } from '../LogoMark'
import { useAppearance } from '../../store'

/**
 * SizeMatrix — a scalability board. The logo is rendered at a fixed ladder of
 * pixel sizes on both a light and a dark swatch strip, so legibility and
 * contrast can be judged independently of the current env.theme. This scene is
 * intentionally taller than the others and wraps responsively.
 */

const SIZES = [16, 24, 32, 48, 64, 96, 128] as const

type RowKind = 'light' | 'dark'

function SizeCell({ size, kind }: { size: number; kind: RowKind }) {
  const app = useAppearance()
  return (
    <div className="flex flex-col items-center gap-2">
      <div
        className="grid place-items-center"
        style={{ width: 128, height: 128 }}
      >
        <LogoMark size={size} showCard={app.cardInFlat} placeholder />
      </div>
      <span
        className="font-mono text-[11px] tabular-nums"
        style={{ color: kind === 'dark' ? '#9aa3b2' : '#8b93a3' }}
      >
        {size}px
      </span>
    </div>
  )
}

function SwatchRow({ kind }: { kind: RowKind }) {
  const isDark = kind === 'dark'
  return (
    <div
      className="rounded-xl border p-5"
      style={{
        backgroundColor: isDark ? '#14161c' : '#ffffff',
        borderColor: isDark ? '#2a2d36' : '#e6e8ec',
        boxShadow: isDark
          ? 'inset 0 1px 0 rgba(255,255,255,0.04)'
          : 'inset 0 1px 0 rgba(255,255,255,0.6)',
      }}
    >
      <div className="mb-4 flex items-center gap-2">
        <span
          className="inline-block h-2.5 w-2.5 rounded-full"
          style={{
            backgroundColor: isDark ? '#3a3d47' : '#e6e8ec',
            border: `1px solid ${isDark ? '#4b5462' : '#d6d9df'}`,
          }}
        />
        <span
          className="text-[11px] font-semibold uppercase tracking-wide"
          style={{ color: isDark ? '#9aa3b2' : '#8b93a3' }}
        >
          {isDark ? 'On dark' : 'On light'}
        </span>
      </div>
      <div className="flex flex-wrap items-end justify-center gap-x-6 gap-y-5">
        {SIZES.map((size) => (
          <SizeCell key={size} size={size} kind={kind} />
        ))}
      </div>
    </div>
  )
}

export default function SizeMatrix() {
  return (
    <div
      className="flex w-full flex-col gap-4 p-5"
      style={{
        background:
          'radial-gradient(120% 80% at 50% 0%, #fafbfc 0%, #f2f3f5 100%)',
      }}
    >
      <SwatchRow kind="light" />
      <SwatchRow kind="dark" />
    </div>
  )
}
