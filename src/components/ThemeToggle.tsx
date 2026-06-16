import { Monitor, Moon, Sun } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useTheme, type ThemeMode } from '../theme'
import { Tooltip } from './ui/Tooltip'

const ICON: Record<ThemeMode, LucideIcon> = {
  light: Sun,
  dark: Moon,
  system: Monitor,
}

const NEXT: Record<ThemeMode, ThemeMode> = {
  light: 'dark',
  dark: 'system',
  system: 'light',
}

const MODE_LABEL: Record<ThemeMode, string> = {
  light: 'Light',
  dark: 'Dark',
  system: 'System',
}

/**
 * Header icon button — cycles light → dark → system, matching the 8×8
 * icon-button styling of the GitHub link / SupportPopover beside it.
 */
export function ThemeToggleButton() {
  const mode = useTheme((s) => s.mode)
  const cycle = useTheme((s) => s.cycle)
  const Icon = ICON[mode]
  const label = `Theme: ${MODE_LABEL[mode]}. Switch to ${MODE_LABEL[NEXT[mode]]}.`
  return (
    <button
      type="button"
      onClick={cycle}
      aria-label={label}
      className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink"
    >
      <Icon size={18} />
      <span className="sr-only">{label}</span>
    </button>
  )
}

const SEGMENTS: { mode: ThemeMode; Icon: LucideIcon }[] = [
  { mode: 'light', Icon: Sun },
  { mode: 'system', Icon: Monitor },
  { mode: 'dark', Icon: Moon },
]

/**
 * Mobile-menu segmented control — pick light / system / dark explicitly. Styled
 * to match the desktop tab nav (surface-3 track, active = raised surface chip).
 */
export function ThemeToggleSegmented() {
  const mode = useTheme((s) => s.mode)
  const setMode = useTheme((s) => s.setMode)
  return (
    <div className="flex h-12 items-center justify-between rounded-lg px-3">
      <span className="text-sm font-medium text-ink-2">Theme</span>
      <div role="radiogroup" aria-label="Theme" className="flex items-center rounded-lg bg-surface-3 p-0.5">
        {SEGMENTS.map(({ mode: m, Icon }) => {
          const active = mode === m
          return (
            <Tooltip key={m} label={MODE_LABEL[m]}>
              <button
                type="button"
                role="radio"
                aria-checked={active}
                aria-label={MODE_LABEL[m]}
                onClick={() => setMode(m)}
                className={`flex h-8 w-9 items-center justify-center rounded-[12px] transition-all ${
                  active ? 'bg-surface text-ink shadow-xs' : 'text-muted hover:text-ink-2'
                }`}
              >
                <Icon size={16} />
              </button>
            </Tooltip>
          )
        })}
      </div>
    </div>
  )
}
