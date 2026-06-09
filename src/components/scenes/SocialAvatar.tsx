import type { CSSProperties } from 'react'
import { LogoMark } from '../LogoMark'
import { useAppearance, useEnv } from '../../store'
import { hexToRgb } from '../../lib/colorUtils'

/**
 * Social profile mock (X / Mastodon flavor) that stress-tests the CIRCULAR
 * avatar crop. A gradient cover banner, a large circular avatar overlapping it,
 * profile metadata + Follow button, and one example post row below. The page
 * chrome flips light/dark via env.theme.
 */
export default function SocialAvatar() {
  const env = useEnv()
  const app = useAppearance()
  const dark = env.theme === 'dark'

  const chrome = dark
    ? {
        bg: '#15202b',
        text: '#e7e9ea',
        sub: '#71767b',
        hair: 'rgba(255,255,255,0.10)',
        followBg: '#eff3f4',
        followText: '#0f1419',
        avatarRing: '#15202b',
        icon: '#71767b',
      }
    : {
        bg: '#ffffff',
        text: '#0f1419',
        sub: '#536471',
        hair: 'rgba(0,0,0,0.08)',
        followBg: '#0f1419',
        followText: '#ffffff',
        avatarRing: '#ffffff',
        icon: '#536471',
      }

  const handle = '@' + (env.brandName || 'brand').toLowerCase().replace(/[^a-z0-9]+/g, '')
  const banner = bannerGradient(app.cardColor, dark)

  return (
    <div
      className="flex w-full flex-col"
      style={{ height: 360, backgroundColor: chrome.bg, color: chrome.text }}
    >
      {/* Cover banner */}
      <div className="relative h-[96px] w-full shrink-0" style={{ background: banner }}>
        {/* Large circular avatar overlapping the banner */}
        <div className="absolute -bottom-9 left-4">
          <div
            className="rounded-full p-[3px]"
            style={{ backgroundColor: chrome.avatarRing }}
          >
            <LogoMark size={88} showCard shape="circle" clip shadow={false} />
          </div>
        </div>
      </div>

      {/* Header actions */}
      <div className="flex justify-end px-4 pt-3">
        <button
          type="button"
          className="rounded-full px-4 py-1.5 text-[14px] font-bold"
          style={{ backgroundColor: chrome.followBg, color: chrome.followText }}
        >
          Follow
        </button>
      </div>

      {/* Identity block */}
      <div className="px-4 pt-3.5">
        <h3 className="text-[18px] font-extrabold leading-tight" style={{ color: chrome.text }}>
          {env.brandName}
        </h3>
        <p className="text-[14px] leading-tight" style={{ color: chrome.sub }}>
          {handle}
        </p>
        <p className="mt-1.5 text-[14px] leading-snug" style={{ color: chrome.text }}>
          Crafting delightful products, one pixel at a time.
        </p>
        <div className="mt-2 flex items-center gap-4 text-[13px]">
          <span style={{ color: chrome.sub }}>
            <strong style={{ color: chrome.text }}>1,284</strong> Following
          </span>
          <span style={{ color: chrome.sub }}>
            <strong style={{ color: chrome.text }}>18.2K</strong> Followers
          </span>
        </div>
      </div>

      {/* Example post row */}
      <div
        className="mt-3.5 flex gap-3 px-4 pt-3.5"
        style={{ borderTop: `1px solid ${chrome.hair}` }}
      >
        <LogoMark size={36} showCard shape="circle" clip shadow={false} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[14px] leading-tight">
            <span className="truncate font-bold" style={{ color: chrome.text }}>
              {env.brandName}
            </span>
            <span className="truncate" style={{ color: chrome.sub }}>
              {handle} · 2h
            </span>
          </div>
          <p className="mt-0.5 text-[14px] leading-snug" style={{ color: chrome.text }}>
            Just shipped a fresh look. Tell us what you think.
          </p>
          <div className="mt-2 flex items-center gap-7" style={{ color: chrome.icon }}>
            <ActionIcon kind="reply" />
            <ActionIcon kind="repost" />
            <ActionIcon kind="like" />
          </div>
        </div>
      </div>
    </div>
  )
}

/* ----------------------------------------------------------------- helpers */

function ActionIcon({ kind }: { kind: 'reply' | 'repost' | 'like' }) {
  const common: CSSProperties = { width: 16, height: 16, fill: 'none', stroke: 'currentColor', strokeWidth: 1.8 }
  if (kind === 'reply') {
    return (
      <svg viewBox="0 0 24 24" style={common} aria-hidden>
        <path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 9.5 9.5 0 0 1-4-.9L3 20l1.9-4.5a8.5 8.5 0 1 1 16.1-4z" strokeLinejoin="round" />
      </svg>
    )
  }
  if (kind === 'repost') {
    return (
      <svg viewBox="0 0 24 24" style={common} aria-hidden>
        <path d="M17 1l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M3 11V9a4 4 0 0 1 4-4h14" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M7 23l-4-4 4-4" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M21 13v2a4 4 0 0 1-4 4H3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 24 24" style={common} aria-hidden>
      <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z" strokeLinejoin="round" />
    </svg>
  )
}

/** On-brand cover gradient seeded from the card color. */
function bannerGradient(cardColor: string, dark: boolean): string {
  const rgb = hexToRgb(cardColor) ?? { r: 91, g: 91, b: 214 }
  const a = (alpha: number) => `rgba(${rgb.r},${rgb.g},${rgb.b},${alpha})`
  if (dark) {
    return `linear-gradient(120deg, ${a(0.55)}, ${a(0.2)} 55%, rgba(21,32,43,0.9))`
  }
  return `linear-gradient(120deg, ${a(0.9)}, ${a(0.5)} 55%, ${a(0.7)})`
}
