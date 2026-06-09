import { useId } from 'react'
import type { CSSProperties } from 'react'
import { LogoMark } from '../LogoMark'
import { useAppearance, useEnv } from '../../store'
import { hexToRgb } from '../../lib/colorUtils'

/**
 * Apple App Store style listing card. Tests the rounded app-icon treatment in a
 * realistic store context: big icon, metadata row with rating + GET button, and
 * a strip of phone screenshot placeholders. Store chrome flips via env.theme.
 */
export default function AppStoreListing() {
  const env = useEnv()
  const app = useAppearance()
  const dark = env.theme === 'dark'

  // Explicit OS chrome colors (not app tokens) so the mock reads as real iOS.
  const chrome = dark
    ? {
        bg: '#000000',
        panel: '#1c1c1e',
        text: '#ffffff',
        sub: '#8e8e93',
        hair: 'rgba(255,255,255,0.10)',
        getBg: '#2c2c2e',
        getText: '#0a84ff',
        star: '#ffd60a',
        starOff: 'rgba(255,255,255,0.20)',
      }
    : {
        bg: '#ffffff',
        panel: '#f2f2f7',
        text: '#1c1c1e',
        sub: '#8a8a8e',
        hair: 'rgba(0,0,0,0.08)',
        getBg: '#e9e9ee',
        getText: '#007aff',
        star: '#ff9500',
        starOff: 'rgba(0,0,0,0.18)',
      }

  // Build tinted gradients for the screenshots, seeded from the card color so
  // the mocked store screens feel on-brand without external assets.
  const tints = screenshotTints(app.cardColor, dark)

  return (
    <div
      className="flex w-full flex-col"
      style={{ height: 360, backgroundColor: chrome.bg, color: chrome.text }}
    >
      {/* Header / metadata row */}
      <div className="flex items-start gap-3.5 px-5 pt-5">
        <LogoMark
          size={88}
          showCard
          shape="rounded"
          radiusPct={22.3}
          shadow={false}
          style={{ boxShadow: dark ? '0 0 0 0.5px rgba(255,255,255,0.10)' : '0 1px 4px rgba(0,0,0,0.12)' }}
        />

        <div className="flex min-w-0 flex-1 flex-col self-stretch">
          <h3
            className="truncate text-[19px] font-semibold leading-tight"
            style={{ color: chrome.text }}
          >
            {env.brandName}
          </h3>
          <p className="mt-0.5 truncate text-[13px]" style={{ color: chrome.sub }}>
            Productivity
          </p>

          <div className="mt-auto flex items-end justify-between pt-2">
            <div className="flex flex-col">
              <div className="flex items-center gap-1">
                <span className="text-[13px] font-semibold tabular-nums" style={{ color: chrome.sub }}>
                  4.8
                </span>
                <Stars rating={4.8} on={chrome.star} off={chrome.starOff} />
              </div>
              <span className="mt-0.5 text-[11px]" style={{ color: chrome.sub }}>
                2.4K Ratings
              </span>
            </div>

            <button
              type="button"
              className="rounded-full px-5 py-1.5 text-[14px] font-bold tracking-tight"
              style={{ backgroundColor: chrome.getBg, color: chrome.getText }}
            >
              GET
            </button>
          </div>
        </div>
      </div>

      {/* Divider */}
      <div className="mx-5 mt-4" style={{ borderTop: `1px solid ${chrome.hair}` }} />

      {/* Screenshots strip */}
      <div className="flex flex-1 items-center gap-3 overflow-hidden px-5 pb-5 pt-4">
        {tints.map((bg, i) => (
          <Screenshot key={i} background={bg} cardShadow={!dark} />
        ))}
      </div>
    </div>
  )
}

/* ----------------------------------------------------------------- helpers */

function Stars({ rating, on, off }: { rating: number; on: string; off: string }) {
  return (
    <div className="flex items-center gap-px">
      {[0, 1, 2, 3, 4].map((i) => {
        // Fraction of this star that is filled (for partial last star).
        const fill = Math.max(0, Math.min(1, rating - i))
        return <Star key={i} fill={fill} on={on} off={off} />
      })}
    </div>
  )
}

function Star({ fill, on, off }: { fill: number; on: string; off: string }) {
  // Stable, collision-free gradient id (Math.random churns + can collide).
  const id = useId()
  return (
    <svg width={13} height={13} viewBox="0 0 24 24" aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="0">
          <stop offset={`${fill * 100}%`} stopColor={on} />
          <stop offset={`${fill * 100}%`} stopColor={off} />
        </linearGradient>
      </defs>
      <path
        d="M12 2.5l2.9 5.88 6.49.94-4.7 4.58 1.11 6.46L12 17.3l-5.8 3.05 1.1-6.46-4.69-4.58 6.49-.94z"
        fill={`url(#${id})`}
      />
    </svg>
  )
}

function Screenshot({ background, cardShadow }: { background: string; cardShadow: boolean }) {
  const style: CSSProperties = {
    aspectRatio: '9 / 16',
    background,
    boxShadow: cardShadow ? '0 6px 18px -8px rgba(0,0,0,0.30)' : '0 0 0 0.5px rgba(255,255,255,0.08)',
  }
  return (
    <div
      className="flex h-full min-w-0 flex-1 items-center justify-center overflow-hidden rounded-[18px]"
      style={style}
    >
      <LogoMark size={40} showCard shape="rounded" radiusPct={22.3} shadow={false} />
    </div>
  )
}

/** Three soft on-brand gradients derived from the card color. */
function screenshotTints(cardColor: string, dark: boolean): string[] {
  const rgb = hexToRgb(cardColor) ?? { r: 91, g: 91, b: 214 }
  const a = (alpha: number) => `rgba(${rgb.r},${rgb.g},${rgb.b},${alpha})`
  const baseTop = dark ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.85)'
  const angle = dark ? '160deg' : '155deg'
  return [
    `linear-gradient(${angle}, ${baseTop}, ${a(dark ? 0.28 : 0.16)})`,
    `linear-gradient(${angle}, ${a(dark ? 0.22 : 0.1)}, ${a(dark ? 0.38 : 0.24)})`,
    `linear-gradient(${angle}, ${baseTop}, ${a(dark ? 0.3 : 0.18)})`,
  ]
}
