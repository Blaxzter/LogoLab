import { useAppearance, useEnv } from '../../store'
import { LogoMark } from '../LogoMark'
import { bestTextColor } from '../../lib/colorUtils'

/**
 * Mobile app splash / launch screen.
 * A rounded phone frame whose full screen background = env.pageBg, with a
 * subtle vignette (deeper in dark theme). The user logo sits centered with the
 * wordmark below it, a thin indeterminate loading bar near the bottom, and a
 * tiny "from BrandName" footer.
 */
export default function SplashScreen() {
  const app = useAppearance()
  const env = useEnv()

  const dark = env.theme === 'dark'
  const textColor = bestTextColor(env.pageBg)
  // Subtle vignette: deepen the corners; darker theme gets a stronger fade.
  const vignette = dark
    ? 'radial-gradient(120% 90% at 50% 35%, rgba(255,255,255,0.04) 0%, rgba(0,0,0,0) 38%, rgba(0,0,0,0.45) 100%)'
    : 'radial-gradient(120% 90% at 50% 35%, rgba(255,255,255,0.35) 0%, rgba(0,0,0,0) 42%, rgba(0,0,0,0.10) 100%)'

  const track = dark ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.10)'
  const bar = textColor === '#ffffff' ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.55)'

  // Neutral stage mat — pinned (not a shell token) so the scene reads
  // identically in app-light and app-dark.
  return (
    <div
      className="flex w-full items-center justify-center py-7"
      style={{ height: 420, backgroundColor: '#f2f3f5' }}
    >
      {/* Phone frame */}
      <div
        className="relative overflow-hidden"
        style={{
          width: 188,
          height: 372,
          borderRadius: 38,
          background: '#0a0b0f',
          padding: 7,
          boxShadow:
            '0 22px 50px -16px rgba(16,18,27,0.45), 0 4px 10px -4px rgba(16,18,27,0.25)',
        }}
      >
        {/* Screen */}
        <div
          className="relative h-full w-full overflow-hidden"
          style={{ borderRadius: 31, backgroundColor: env.pageBg }}
        >
          {/* Vignette overlay */}
          <div className="pointer-events-none absolute inset-0" style={{ background: vignette }} />

          {/* Notch */}
          <div
            className="absolute left-1/2 top-2 -translate-x-1/2 rounded-full"
            style={{ width: 56, height: 16, backgroundColor: '#0a0b0f' }}
          />

          {/* Centered subject */}
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-6">
            <LogoMark size={100} showCard={app.cardInFlat} />
            <span
              className="text-[19px] font-semibold tracking-tight"
              style={{ color: textColor }}
            >
              {env.brandName}
            </span>
          </div>

          {/* Bottom: loading indicator + footer */}
          <div className="absolute inset-x-0 bottom-7 flex flex-col items-center gap-3 px-10">
            <div
              className="relative h-[3px] w-full overflow-hidden rounded-full"
              style={{ backgroundColor: track }}
            >
              <span
                className="splash-indeterminate absolute inset-y-0 rounded-full"
                style={{ width: '40%', backgroundColor: bar }}
              />
            </div>
            <span
              className="text-[10px] font-medium tracking-wide"
              style={{ color: textColor, opacity: 0.45 }}
            >
              from {env.brandName}
            </span>
          </div>
        </div>
      </div>

      <style>{`
        @keyframes splash-indeterminate {
          0%   { left: -40%; }
          100% { left: 100%; }
        }
        .splash-indeterminate {
          animation: splash-indeterminate 1.4s cubic-bezier(0.4, 0, 0.2, 1) infinite;
        }
      `}</style>
    </div>
  )
}
