import { create } from 'zustand'

/**
 * App theme — a small, standalone store (deliberately separate from the
 * session-only `useStore`, which intentionally never persists). Supports three
 * modes; only the chosen MODE is persisted, so `system` keeps tracking the OS.
 *
 * Applying a theme = toggling the `dark` class on <html>; the CSS token overrides
 * under `.dark` (see index.css) do the rest. An inline `index.html` script sets
 * the same class before first paint to avoid a flash of the wrong theme.
 */

export type ThemeMode = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

export const THEME_STORAGE_KEY = 'logolab-theme'

/** Light → dark → system → light. */
export const THEME_ORDER: ThemeMode[] = ['light', 'dark', 'system']

const darkQuery = () => window.matchMedia('(prefers-color-scheme: dark)')

function readStoredMode(): ThemeMode {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY)
    if (v === 'light' || v === 'dark' || v === 'system') return v
  } catch {
    /* localStorage can throw in privacy mode / sandboxed contexts — fall through */
  }
  return 'system'
}

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && 'matchMedia' in window && darkQuery().matches
}

/** Collapse a mode to the concrete theme that should be on screen right now. */
export function resolveTheme(mode: ThemeMode): ResolvedTheme {
  if (mode === 'system') return systemPrefersDark() ? 'dark' : 'light'
  return mode
}

/** Reflect the resolved theme onto the document (class + native color-scheme). */
function applyResolved(resolved: ResolvedTheme): void {
  const root = document.documentElement
  root.classList.toggle('dark', resolved === 'dark')
  // Keep the inline color-scheme in lockstep with the class so it can't go stale
  // on toggle (the anti-FOUC script may have set it before CSS loaded).
  root.style.colorScheme = resolved
}

interface ThemeState {
  /** The user's chosen mode (persisted). */
  mode: ThemeMode
  /** The theme actually on screen (mode with `system` resolved). */
  resolved: ResolvedTheme
  setMode: (mode: ThemeMode) => void
  /** Step to the next mode in {@link THEME_ORDER}. */
  cycle: () => void
}

export const useTheme = create<ThemeState>((set, get) => {
  const mode = readStoredMode()
  const resolved = resolveTheme(mode)

  // Sync the DOM with the stored mode on first import. Usually a no-op (the
  // anti-FOUC script already applied it), but corrects any drift.
  applyResolved(resolved)

  // While in `system` mode, follow live OS preference changes.
  if (typeof window !== 'undefined' && 'matchMedia' in window) {
    darkQuery().addEventListener('change', (e) => {
      if (get().mode !== 'system') return
      const next: ResolvedTheme = e.matches ? 'dark' : 'light'
      applyResolved(next)
      set({ resolved: next })
    })
  }

  return {
    mode,
    resolved,
    setMode: (next) => {
      try {
        localStorage.setItem(THEME_STORAGE_KEY, next)
      } catch {
        /* persistence is best-effort */
      }
      const r = resolveTheme(next)
      applyResolved(r)
      set({ mode: next, resolved: r })
    },
    cycle: () => {
      const order = THEME_ORDER
      get().setMode(order[(order.indexOf(get().mode) + 1) % order.length])
    },
  }
})
