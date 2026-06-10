import { Circle, RotateCcw, Square, Squircle } from 'lucide-react'
import { useAppearance, useEnv, useStore } from '../store'
import { useActiveTab } from '../hooks/useActiveTab'
import { UploadDropzone } from './UploadDropzone'
import { TryExampleButton } from './ExamplesDialog'
import { ColorField, Field, Segmented, Slider, TextField, Toggle } from './ui/controls'
import { Button } from './ui/Button'
import type { IconShape } from '../types'

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[0.7rem] font-bold uppercase tracking-wider text-faint">{children}</h3>
  )
}

export function Sidebar() {
  const tab = useActiveTab()
  const app = useAppearance()
  const env = useEnv()
  const setAppearance = useStore((s) => s.setAppearance)
  const setEnv = useStore((s) => s.setEnv)
  const resetAppearance = useStore((s) => s.resetAppearance)

  // Only Preview and Export consume the appearance/branding controls. Cleanup
  // and Vectorize work on the raw pixels and read nothing but the logo, so their
  // styling controls would be inert — hide them there. The Logo section stays in
  // every view (you load / swap / pick an example from it everywhere).
  const isPreview = tab === 'preview'
  const showStyling = isPreview || tab === 'export'
  // Cleanup & Vectorize don't use any sidebar controls (and load logos from their
  // own empty state), so the whole panel slides away there for a roomier canvas.
  const collapsed = tab === 'cleanup' || tab === 'vectorize'

  const shapeOptions: { value: IconShape; label: React.ReactNode; title: string }[] = [
    { value: 'rounded', label: <Squircle size={15} />, title: 'Rounded' },
    { value: 'circle', label: <Circle size={15} />, title: 'Circle' },
    { value: 'square', label: <Square size={15} />, title: 'Square' },
  ]

  return (
    <aside
      aria-hidden={collapsed}
      inert={collapsed}
      style={{ width: collapsed ? 0 : '20rem' }}
      className={`h-full min-w-0 shrink-0 overflow-hidden border-line bg-surface transition-[width] duration-300 ease-in-out ${
        collapsed ? 'border-r-0' : 'border-r'
      }`}
    >
      {/* Fixed-width inner so content doesn't reflow while the panel clips it. */}
      <div className="flex h-full w-80 flex-col">
        <div className="flex flex-col gap-6 overflow-y-auto p-4">
          {/* Logo — needed in every view */}
          <section className="flex flex-col gap-3">
            <SectionTitle>Logo</SectionTitle>
            <UploadDropzone />
            <TryExampleButton />
          </section>

        {showStyling && (
          <>
            {/* Size */}
            <section className="flex flex-col gap-4">
              <SectionTitle>Size &amp; spacing</SectionTitle>
              <Field label="Logo scale">
                <Slider
                  value={Math.round(app.scale * 100)}
                  min={30}
                  max={120}
                  unit="%"
                  onChange={(v) => setAppearance({ scale: v / 100 })}
                />
              </Field>
              <Field label="Safe-zone padding">
                <Slider
                  value={app.padding}
                  min={0}
                  max={35}
                  unit="%"
                  onChange={(v) => setAppearance({ padding: v })}
                />
              </Field>
            </section>

            {/* Background card */}
            <section className="flex flex-col gap-4">
              <div className="flex items-center justify-between">
                <SectionTitle>Background card</SectionTitle>
                {/* "Draw card in flat contexts" only affects the Preview scenes. */}
                {isPreview && (
                  <Toggle
                    checked={app.cardInFlat}
                    onChange={(v) => setAppearance({ cardInFlat: v })}
                  />
                )}
              </div>
              {isPreview && (
                <p className="-mt-2 text-xs leading-snug text-muted">
                  Adds a colored backplate behind the logo (great for white line-art). Always on for
                  app-icon scenes; toggle controls flat scenes like nav bars &amp; favicons.
                </p>
              )}
              <Field label="Card color">
                <ColorField
                  value={app.cardColor}
                  onChange={(v) => setAppearance({ cardColor: v })}
                  allowTransparent
                />
              </Field>
              <Field label="Shape">
                <Segmented
                  value={app.cardShape}
                  options={shapeOptions}
                  onChange={(v) => setAppearance({ cardShape: v })}
                />
              </Field>
              {app.cardShape === 'rounded' && (
                <Field label="Corner radius">
                  <Slider
                    value={app.cardRadius}
                    min={0}
                    max={50}
                    unit="%"
                    onChange={(v) => setAppearance({ cardRadius: v })}
                  />
                </Field>
              )}
              {/* Drop shadow is a Preview-scene flourish; export icons don't use it. */}
              {isPreview && (
                <Toggle
                  checked={app.cardShadow}
                  onChange={(v) => setAppearance({ cardShadow: v })}
                  label="Drop shadow"
                />
              )}
            </section>

            {/* Recolor */}
            <section className="flex flex-col gap-4">
              <div className="flex items-center justify-between">
                <SectionTitle>Recolor</SectionTitle>
                <Toggle
                  checked={app.tintEnabled}
                  onChange={(v) => setAppearance({ tintEnabled: v })}
                />
              </div>
              <p className="-mt-2 text-xs leading-snug text-muted">
                Paint a monochrome logo a single color via its alpha — preview a white mark in any
                brand color.
              </p>
              {app.tintEnabled && (
                <Field label="Tint color">
                  <ColorField value={app.tintColor} onChange={(v) => setAppearance({ tintColor: v })} />
                </Field>
              )}
              <Toggle
                checked={app.invert}
                onChange={(v) => setAppearance({ invert: v })}
                label="Invert colors"
              />
            </section>
          </>
        )}

        {/* Environment (Preview) / Branding (Export). Theme & page background only
            drive the Preview scenes; the brand name also names the PWA manifest. */}
        {showStyling && (
          <section className="flex flex-col gap-4">
            <SectionTitle>{isPreview ? 'Environment' : 'Branding'}</SectionTitle>
            {isPreview && (
              <Field label="Preview theme">
                <Segmented
                  value={env.theme}
                  options={[
                    { value: 'light', label: 'Light' },
                    { value: 'dark', label: 'Dark' },
                  ]}
                  onChange={(v) => setEnv({ theme: v })}
                />
              </Field>
            )}
            {isPreview && (
              <Field label="Page background">
                <ColorField value={env.pageBg} onChange={(v) => setEnv({ pageBg: v })} />
              </Field>
            )}
            <Field
              label="Brand name"
              hint={isPreview ? 'Shown as the app/site name inside mockups.' : 'Names the PWA manifest & exported files.'}
            >
              <TextField
                value={env.brandName}
                onChange={(v) => setEnv({ brandName: v })}
                placeholder="Acme"
                maxLength={24}
              />
            </Field>
          </section>
        )}

        {showStyling && (
          <Button variant="ghost" icon={<RotateCcw size={14} />} onClick={resetAppearance}>
            Reset appearance
          </Button>
        )}
        </div>
      </div>
    </aside>
  )
}
