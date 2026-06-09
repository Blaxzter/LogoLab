import { Circle, RotateCcw, Square, Squircle } from 'lucide-react'
import { useAppearance, useEnv, useStore } from '../store'
import { UploadDropzone } from './UploadDropzone'
import { ColorField, Field, Segmented, Slider, TextField, Toggle } from './ui/controls'
import { Button } from './ui/Button'
import type { IconShape } from '../types'

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[0.7rem] font-bold uppercase tracking-wider text-faint">{children}</h3>
  )
}

export function Sidebar() {
  const app = useAppearance()
  const env = useEnv()
  const setAppearance = useStore((s) => s.setAppearance)
  const setEnv = useStore((s) => s.setEnv)
  const resetAppearance = useStore((s) => s.resetAppearance)

  const shapeOptions: { value: IconShape; label: React.ReactNode; title: string }[] = [
    { value: 'rounded', label: <Squircle size={15} />, title: 'Rounded' },
    { value: 'circle', label: <Circle size={15} />, title: 'Circle' },
    { value: 'square', label: <Square size={15} />, title: 'Square' },
  ]

  return (
    <aside className="flex h-full w-80 shrink-0 flex-col border-r border-line bg-surface">
      <div className="flex flex-col gap-6 overflow-y-auto p-4">
        {/* Upload */}
        <section className="flex flex-col gap-3">
          <SectionTitle>Logo</SectionTitle>
          <UploadDropzone />
        </section>

        {/* Size */}
        <section className="flex flex-col gap-4">
          <SectionTitle>Size & spacing</SectionTitle>
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
            <Toggle
              checked={app.cardInFlat}
              onChange={(v) => setAppearance({ cardInFlat: v })}
            />
          </div>
          <p className="-mt-2 text-xs leading-snug text-muted">
            Adds a colored backplate behind the logo (great for white line-art). Always on for
            app-icon scenes; toggle controls flat scenes like nav bars & favicons.
          </p>
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
          <Toggle
            checked={app.cardShadow}
            onChange={(v) => setAppearance({ cardShadow: v })}
            label="Drop shadow"
          />
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

        {/* Environment */}
        <section className="flex flex-col gap-4">
          <SectionTitle>Environment</SectionTitle>
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
          <Field label="Page background">
            <ColorField value={env.pageBg} onChange={(v) => setEnv({ pageBg: v })} />
          </Field>
          <Field label="Brand name" hint="Shown as the app/site name inside mockups.">
            <TextField
              value={env.brandName}
              onChange={(v) => setEnv({ brandName: v })}
              placeholder="Acme"
              maxLength={24}
            />
          </Field>
        </section>

        <Button variant="ghost" icon={<RotateCcw size={14} />} onClick={resetAppearance}>
          Reset appearance
        </Button>
      </div>
    </aside>
  )
}
