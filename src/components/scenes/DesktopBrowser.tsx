import { useAppearance, useEnv } from '../../store'
import { LogoMark } from '../LogoMark'

/**
 * Full-width desktop website mock inside a browser window chrome.
 * The site itself switches light/dark via env.theme. This is the key
 * "full desktop width, top-left logo" test: nav bar with logo + brand on the
 * left, links + a primary pill on the right, then a hero with a headline,
 * subtext, two buttons, and a placeholder media block.
 */
export default function DesktopBrowser() {
  const app = useAppearance()
  const env = useEnv()

  const dark = env.theme === 'dark'

  // Explicit hex colors for the browser chrome + mocked site internals.
  const chromeBg = dark ? '#2b2d33' : '#e9eaed'
  const chromeBorder = dark ? '#3a3d45' : '#dcdee2'
  const addressBg = dark ? '#1f2126' : '#ffffff'
  const addressText = dark ? '#c6c9d1' : '#5b6270'
  const addressBorder = dark ? '#3a3d45' : '#e3e5e9'

  // Site palette
  const siteBg = dark ? '#0e0f14' : '#ffffff'
  const navBg = dark ? '#13151b' : '#ffffff'
  const navBorder = dark ? '#23262f' : '#eceef1'
  const headline = dark ? '#f3f4f7' : '#14161c'
  const subtext = dark ? '#9aa1ad' : '#5b6270'
  const navLink = dark ? '#aab0bb' : '#5b6270'
  const accent = '#5b5bd6'
  const ghostBorder = dark ? '#2f323b' : '#dcdee2'
  const ghostText = dark ? '#e3e5e9' : '#2b2f38'
  const heroFrom = dark ? '#1a1d26' : '#f1f2fb'
  const heroTo = dark ? '#0f1118' : '#e9eafb'

  const domain = env.brandName.toLowerCase().replace(/\s+/g, '') + '.com'

  return (
    <div className="w-full bg-surface-3 p-4">
      {/* Browser window */}
      <div
        className="overflow-hidden rounded-xl"
        style={{
          backgroundColor: siteBg,
          border: `1px solid ${chromeBorder}`,
          boxShadow: '0 18px 44px -16px rgba(16,18,27,0.30), 0 4px 10px -4px rgba(16,18,27,0.14)',
        }}
      >
        {/* Chrome bar */}
        <div
          className="flex items-center gap-3 px-3.5"
          style={{ height: 38, backgroundColor: chromeBg, borderBottom: `1px solid ${chromeBorder}` }}
        >
          <div className="flex shrink-0 items-center gap-2">
            <span className="h-3 w-3 rounded-full" style={{ backgroundColor: '#ff5f57' }} />
            <span className="h-3 w-3 rounded-full" style={{ backgroundColor: '#febc2e' }} />
            <span className="h-3 w-3 rounded-full" style={{ backgroundColor: '#28c840' }} />
          </div>
          {/* Address bar */}
          <div
            className="flex h-[24px] min-w-0 flex-1 items-center gap-2 rounded-full px-2.5"
            style={{ backgroundColor: addressBg, border: `1px solid ${addressBorder}` }}
          >
            <LogoMark size={16} showCard={app.cardInFlat} placeholder />
            <span className="truncate text-xs" style={{ color: addressText }}>
              {domain}
            </span>
          </div>
        </div>

        {/* Top nav bar */}
        <div
          className="flex items-center justify-between px-6"
          style={{ height: 56, backgroundColor: navBg, borderBottom: `1px solid ${navBorder}` }}
        >
          <div className="flex items-center gap-2.5">
            <LogoMark size={28} showCard={app.cardInFlat} />
            <span className="text-[15px] font-semibold tracking-tight" style={{ color: headline }}>
              {env.brandName}
            </span>
          </div>
          <div className="flex items-center gap-5">
            <nav className="hidden items-center gap-5 sm:flex">
              {['Features', 'Pricing', 'Docs'].map((link) => (
                <span key={link} className="text-[13px] font-medium" style={{ color: navLink }}>
                  {link}
                </span>
              ))}
            </nav>
            <span
              className="rounded-full px-3.5 py-1.5 text-[13px] font-semibold text-white"
              style={{ backgroundColor: accent }}
            >
              Sign up
            </span>
          </div>
        </div>

        {/* Hero */}
        <div className="flex flex-col gap-6 px-8 py-9">
          <div className="flex max-w-[520px] flex-col gap-3.5">
            <h1
              className="text-[28px] font-bold leading-[1.12] tracking-tight"
              style={{ color: headline }}
            >
              Build something brilliant with {env.brandName}.
            </h1>
            <p className="text-[14px] leading-relaxed" style={{ color: subtext }}>
              The all-in-one platform that helps your team ship faster, stay aligned,
              and look effortlessly professional.
            </p>
            <div className="mt-1 flex items-center gap-3">
              <span
                className="rounded-lg px-4 py-2 text-[13px] font-semibold text-white"
                style={{ backgroundColor: accent }}
              >
                Get started
              </span>
              <span
                className="rounded-lg px-4 py-2 text-[13px] font-semibold"
                style={{ border: `1px solid ${ghostBorder}`, color: ghostText }}
              >
                Learn more
              </span>
            </div>
          </div>

          {/* Placeholder media / preview block */}
          <div
            className="flex items-center justify-center overflow-hidden rounded-xl"
            style={{
              height: 168,
              background: `linear-gradient(135deg, ${heroFrom} 0%, ${heroTo} 100%)`,
              border: `1px solid ${navBorder}`,
            }}
          >
            <div style={{ opacity: 0.35 }}>
              <LogoMark size={48} showCard={false} />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
