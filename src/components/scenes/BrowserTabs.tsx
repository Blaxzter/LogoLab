import type { CSSProperties } from 'react'
import { LogoMark } from '../LogoMark'
import { useAppearance, useEnv } from '../../store'

/**
 * BrowserTabs — a browser tab-strip + address bar mock that stress-tests
 * FAVICON legibility at 16px. The active tab, address bar, and one bookmark
 * carry the user logo; everything else is a generic gray placeholder, so the
 * tiny mark can be judged against realistic browser chrome.
 */

interface Chrome {
  /** Window / toolbar surface. */
  bar: string
  /** Active tab fill (reads like a continuation of the toolbar). */
  tabActive: string
  /** Inactive tab strip backdrop. */
  strip: string
  /** Address / bookmark input pill. */
  pill: string
  /** Primary chrome text. */
  text: string
  /** Secondary / muted chrome text. */
  textMuted: string
  /** Generic favicon disc + bookmark dot color. */
  generic: string
  /** Hairline separators. */
  line: string
  /** URL host accent (the secure part). */
  hostStrong: string
}

const LIGHT: Chrome = {
  bar: '#ffffff',
  tabActive: '#ffffff',
  strip: '#dee1e6',
  pill: '#f1f3f4',
  text: '#202124',
  textMuted: '#5f6368',
  generic: '#bdc1c6',
  line: '#e4e6ea',
  hostStrong: '#202124',
}

const DARK: Chrome = {
  bar: '#202124',
  tabActive: '#35363a',
  strip: '#202124',
  pill: '#28292c',
  text: '#e8eaed',
  textMuted: '#9aa0a6',
  generic: '#5f6368',
  line: '#3c4043',
  hostStrong: '#e8eaed',
}

function GenericFavicon({ color }: { color: string }) {
  return (
    <span
      className="inline-block shrink-0 rounded-full"
      style={{ width: 16, height: 16, backgroundColor: color }}
    />
  )
}

function WindowDot({ color }: { color: string }) {
  return (
    <span
      className="inline-block rounded-full"
      style={{ width: 8, height: 8, backgroundColor: color }}
    />
  )
}

export default function BrowserTabs() {
  const app = useAppearance()
  const env = useEnv()
  const c = env.theme === 'dark' ? DARK : LIGHT
  const brand = env.brandName || 'Acme'
  const host = `${brand.toLowerCase().replace(/[^a-z0-9]/g, '')}.com`

  // Slanted/rounded-top tab silhouette via individual top corners.
  const activeTabStyle: CSSProperties = {
    backgroundColor: c.tabActive,
    borderTopLeftRadius: 10,
    borderTopRightRadius: 10,
  }

  return (
    <div
      className="flex w-full flex-col select-none"
      style={{ height: 300, backgroundColor: c.strip }}
    >
      {/* Tab strip */}
      <div className="flex items-end gap-1 px-2 pt-2" style={{ height: 44 }}>
        {/* Pinned tab — favicon only, narrow */}
        <div
          className="flex items-center justify-center"
          style={{
            ...activeTabStyle,
            backgroundColor: env.theme === 'dark' ? '#2a2b2e' : '#eceef1',
            width: 36,
            height: 34,
          }}
          title="Pinned"
        >
          <LogoMark size={16} showCard={app.cardInFlat} radiusPct={20} placeholder />
        </div>

        {/* Active tab — user favicon + brand title */}
        <div
          className="flex items-center gap-2 px-3"
          style={{ ...activeTabStyle, width: 168, height: 34 }}
        >
          <LogoMark size={16} showCard={app.cardInFlat} radiusPct={20} placeholder />
          <span
            className="flex-1 truncate text-[12px] font-medium"
            style={{ color: c.text }}
          >
            {brand}
          </span>
          <span
            className="grid h-4 w-4 shrink-0 place-items-center rounded-full text-[11px] leading-none"
            style={{ color: c.textMuted }}
          >
            ×
          </span>
        </div>

        {/* Inactive tabs — generic */}
        {['Search', 'Docs'].map((label) => (
          <div
            key={label}
            className="flex items-center gap-2 px-3"
            style={{
              width: 150,
              height: 32,
              borderTopLeftRadius: 10,
              borderTopRightRadius: 10,
              backgroundColor: env.theme === 'dark' ? '#2a2b2e' : '#eceef1',
            }}
          >
            <GenericFavicon color={c.generic} />
            <span
              className="flex-1 truncate text-[12px]"
              style={{ color: c.textMuted }}
            >
              {label}
            </span>
            <span
              className="shrink-0 text-[11px] leading-none"
              style={{ color: c.textMuted }}
            >
              ×
            </span>
          </div>
        ))}

        {/* New-tab button */}
        <div
          className="grid place-items-center rounded-full text-[15px] leading-none"
          style={{ width: 26, height: 26, color: c.textMuted }}
        >
          +
        </div>
      </div>

      {/* Toolbar: nav buttons + address bar */}
      <div
        className="flex items-center gap-2 px-3"
        style={{ height: 48, backgroundColor: c.bar }}
      >
        <div className="flex items-center gap-3" style={{ color: c.textMuted }}>
          <span className="text-[16px] leading-none">‹</span>
          <span className="text-[16px] leading-none">›</span>
          <span className="text-[15px] leading-none">⟳</span>
        </div>
        <div
          className="flex h-8 flex-1 items-center gap-2 rounded-full px-3"
          style={{ backgroundColor: c.pill }}
        >
          <LogoMark size={16} showCard={app.cardInFlat} radiusPct={20} placeholder />
          <span className="text-[12px]" style={{ color: c.hostStrong }}>
            {host}
          </span>
          <span className="text-[12px]" style={{ color: c.textMuted }}>
            /pricing
          </span>
          <span className="ml-auto text-[13px]" style={{ color: c.textMuted }}>
            ☆
          </span>
        </div>
        <div
          className="grid h-7 w-7 place-items-center rounded-full text-[13px]"
          style={{ backgroundColor: c.generic, color: c.bar }}
        >
          {brand.charAt(0).toUpperCase()}
        </div>
      </div>

      {/* Bookmarks bar */}
      <div
        className="flex items-center gap-1 px-3"
        style={{
          height: 36,
          backgroundColor: c.bar,
          borderTop: `1px solid ${c.line}`,
        }}
      >
        {/* The one branded bookmark */}
        <div className="flex items-center gap-1.5 rounded-md px-1.5 py-1">
          <LogoMark size={16} showCard={app.cardInFlat} radiusPct={20} placeholder />
          <span className="text-[12px]" style={{ color: c.text }}>
            {brand}
          </span>
        </div>
        {/* Generic bookmarks */}
        {['Mail', 'Calendar', 'Drive', 'News'].map((label) => (
          <div
            key={label}
            className="flex items-center gap-1.5 rounded-md px-1.5 py-1"
          >
            <GenericFavicon color={c.generic} />
            <span className="text-[12px]" style={{ color: c.textMuted }}>
              {label}
            </span>
          </div>
        ))}
        <div className="ml-auto flex items-center gap-1.5">
          <WindowDot color={c.generic} />
          <WindowDot color={c.generic} />
          <WindowDot color={c.generic} />
        </div>
      </div>

      {/* Page peek — a hint of the rendered site below the chrome */}
      <div
        className="flex-1"
        style={{
          background:
            env.theme === 'dark'
              ? 'linear-gradient(180deg, #1b1c1f 0%, #161719 100%)'
              : `linear-gradient(180deg, ${env.pageBg} 0%, #f5f6f8 100%)`,
        }}
      />
    </div>
  )
}
