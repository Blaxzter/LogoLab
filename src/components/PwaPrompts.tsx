// The "Install app" button. The service worker's notices live in Toasts.tsx.

import { Download } from 'lucide-react'
import { usePwa } from '../pwa/register'
import { Tooltip } from './ui/Tooltip'

/**
 * Rendered only while the browser is offering an install; the prompt event
 * arrives once per eligible visit and can't be replayed.
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
    <Tooltip label="Install LogoLab as an app" side="bottom">
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
