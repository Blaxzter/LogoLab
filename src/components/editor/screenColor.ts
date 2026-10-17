// The browser's own eyedropper (`window.EyeDropper`): a colour from anywhere on screen.
//
// Chromium only, so far. Where it is missing the Inspector shows no pipette at
// all rather than a button that explains it cannot work: the hex field and the
// picker beside it already do the job.

import { normalizeHex } from '../../lib/colorUtils.ts'

interface EyeDropperLike {
  open(options?: { signal?: AbortSignal }): Promise<{ sRGBHex: string }>
}
type EyeDropperCtor = new () => EyeDropperLike

function ctor(scope: unknown): EyeDropperCtor | null {
  const c = (scope as { EyeDropper?: unknown } | undefined)?.EyeDropper
  return typeof c === 'function' ? (c as EyeDropperCtor) : null
}

/** Whether this browser has a screen eyedropper. */
export function hasScreenEyeDropper(scope: unknown = globalThis): boolean {
  return ctor(scope) !== null
}

/**
 * Let the user sample a colour off the screen. Resolves to `#rrggbb`, or null
 * when they cancel (Esc), the browser refuses, or it answers in a form we
 * can't read. Never rejects: a cancelled pick is not an error.
 */
export async function pickScreenColor(scope: unknown = globalThis): Promise<string | null> {
  const C = ctor(scope)
  if (!C) return null
  try {
    const { sRGBHex } = await new C().open()
    return normalizeHex(sRGBHex) ?? rgbToHex(sRGBHex)
  } catch {
    return null
  }
}

/** `rgb(…)` / `rgba(…)` → `#rrggbb`: the spec asks for hex, but older builds answered in CSS rgb. */
function rgbToHex(s: string): string | null {
  const m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(s.trim())
  if (!m) return null
  const h = (v: string) => Math.min(255, Number(v)).toString(16).padStart(2, '0')
  return `#${h(m[1])}${h(m[2])}${h(m[3])}`
}
