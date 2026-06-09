import type { ComponentType } from 'react'
import { useLogo } from '../store'
import PhoneHomeIOS from './scenes/PhoneHomeIOS'
import PhoneHomeAndroid from './scenes/PhoneHomeAndroid'
import SplashScreen from './scenes/SplashScreen'
import DesktopBrowser from './scenes/DesktopBrowser'
import BrowserTabs from './scenes/BrowserTabs'
import SizeMatrix from './scenes/SizeMatrix'
import AppStoreListing from './scenes/AppStoreListing'
import SocialAvatar from './scenes/SocialAvatar'

interface SceneDef {
  id: string
  title: string
  desc: string
  Component: ComponentType
  /** Tailwind column-span classes for the responsive grid. */
  span?: string
}

const SCENES: SceneDef[] = [
  { id: 'ios', title: 'iOS home screen', desc: 'Real screenshot — drag your icon into a slot', Component: PhoneHomeIOS },
  { id: 'android', title: 'Android home screen', desc: 'Real screenshot — drag your icon into a slot', Component: PhoneHomeAndroid },
  { id: 'splash', title: 'App splash screen', desc: 'Launch / startup screen', Component: SplashScreen },
  {
    id: 'desktop',
    title: 'Website — desktop',
    desc: 'Full-width nav, logo top-left',
    Component: DesktopBrowser,
    span: 'md:col-span-2 2xl:col-span-2',
  },
  { id: 'tabs', title: 'Browser tabs & favicon', desc: 'Legibility at 16px', Component: BrowserTabs },
  { id: 'store', title: 'App Store listing', desc: 'Icon, title & screenshots', Component: AppStoreListing },
  { id: 'social', title: 'Social profile', desc: 'Circular avatar crop', Component: SocialAvatar },
  {
    id: 'sizes',
    title: 'Size & contrast',
    desc: 'Every size, on light and dark',
    Component: SizeMatrix,
    span: 'md:col-span-2 2xl:col-span-3',
  },
]

export function PreviewGrid() {
  const logo = useLogo()

  return (
    <div className="mx-auto max-w-[1400px] p-5 sm:p-6">
      <div className="mb-5 flex items-end justify-between">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-ink">Previews</h2>
          <p className="text-sm text-muted">
            {logo.src
              ? 'Your logo, rendered across real-world contexts. Tweak it in the sidebar.'
              : 'Drop a logo in the sidebar — every scene updates live. (Showing placeholders.)'}
          </p>
        </div>
        <span className="hidden rounded-full bg-surface-3 px-2.5 py-1 text-xs font-medium text-muted sm:inline">
          {SCENES.length} contexts
        </span>
      </div>

      <div className="grid grid-cols-1 gap-5 md:grid-cols-2 2xl:grid-cols-3">
        {SCENES.map(({ id, title, desc, Component, span }) => (
          <section key={id} className={`scene-card animate-in-fade flex flex-col ${span ?? ''}`}>
            <header className="flex items-center justify-between border-b border-line px-4 py-2.5">
              <div className="min-w-0">
                <h3 className="truncate text-sm font-semibold text-ink">{title}</h3>
                <p className="truncate text-xs text-muted">{desc}</p>
              </div>
            </header>
            <div className="flex-1">
              <Component />
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}
