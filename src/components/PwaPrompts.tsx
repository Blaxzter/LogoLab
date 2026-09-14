// The install affordance. The service worker's two NOTICES live in Toasts.tsx
// with the rest of the app's transient messages; this is a control, so it sits
// in the header with the other controls.

import { Download } from 'lucide-react'
import { usePwa } from '../pwa/register'
import { Tooltip } from './ui/Tooltip'

/**
 * "Install app", shown only while the browser is actually offering it — the
 * event arrives once per eligible visit and cannot be replayed, so there is no
 * honest way to render this button the rest of the time.
 */
export function InstallAppButton({
  variant = 'icon',
  className = '',
  onInstalled,
}: {
  variant?: 'icon' | 'ghost'
  className?: string
  onInstalled?: () => void
}) {
  const installPrompt = usePwa((s) => s.installPrompt)
  const install = usePwa((s) => s.install)

  if (!installPrompt) return null

  const run = () => {
    void install().then(() => onInstalled?.())
  }

  if (variant === 'ghost') {
    return (
      <button type="button" onClick={run} className={className}>
        <span className="grid h-5 w-5 place-items-center">
          <Download size={16} />
        </span>
        Install app
      </button>
    )
  }

  return (
    <Tooltip label="Install LogoLab as an app">
      <button
        type="button"
        onClick={run}
        aria-label="Install LogoLab as an app"
        className={`flex h-8 w-8 items-center justify-center rounded-lg text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink ${className}`}
      >
        <Download size={16} />
      </button>
    </Tooltip>
  )
}
