import { Contrast } from 'lucide-react'
import { useStore } from '../../store'

/**
 * Flips the global transparency-checkerboard backdrop (light ⇄ dark). The state
 * lives in the store, so flipping here changes every preview — cleanup,
 * vectorize, export — and sticks for the rest of the session.
 */
export function CheckerToggle({ className = '' }: { className?: string }) {
  const dark = useStore((s) => s.checkerDark)
  const toggle = useStore((s) => s.toggleChecker)
  return (
    <button
      type="button"
      onClick={toggle}
      title={`Flip preview background (currently ${dark ? 'dark' : 'light'}) — see white logos better`}
      className={`flex h-8 w-8 items-center justify-center rounded-lg border shadow-xs transition-colors ${
        dark
          ? 'border-white/20 bg-black/40 text-white hover:bg-black/60'
          : 'border-line-strong bg-surface/80 text-ink-2 hover:bg-surface'
      } ${className}`}
    >
      <Contrast size={15} />
      <span className="sr-only">Flip preview background</span>
    </button>
  )
}
